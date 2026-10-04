"""Analysis pipeline: audio -> beats/downbeats, chord segments, key, waveform.

Two chord recognizers share the post-processing:
  * ``neural`` (default when madmom is installed): CNN chord features + CRF potentials
    (maj/min/N), deep chroma + NNLS chroma for chord qualities, BLSTM + DBN beat/downbeat
    tracking, key CNN.
  * ``dsp`` (fallback, librosa/numpy only): NNLS-style chroma, full-vocabulary template
    HMM, librosa beat tracking, meter from chord-change alignment.
Both decode with beat-aware change penalties, snap chord changes to beats, absorb
too-short segments, refine qualities/basses and merge identical neighbours.
"""
from __future__ import annotations

import logging
import os
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np

from . import decoding as dec
from .audio import frame_rms_db, waveform_peaks
from .chords import ENGINE_QUALITIES, NO_CHORD, Chord
from .errors import EngineError
from .features import ChromaFeatures, chroma_features, estimate_tuning, to_22k
from .key import detect_key
from .refine import (DEFAULT_PARAMS, Evidence, RefineParams, bernoulli_scores, chroma_probabilities,
                     deep_chroma_probabilities, refine_segment)
from .rhythm import Rhythm, choose_meter, from_dbn, librosa_rhythm, tempo_from_beats

log = logging.getLogger(__name__)

SR = 44100
ProgressFn = Callable[[float, str], None]

MIN_DURATION = 0.5  # seconds; anything shorter is reported as a single "N" segment
EXTENDED_CONFIDENCE = 0.85


@dataclass
class Params:
    # beat-aware decoding: extra log-cost of a chord change away from a beat / off-beat
    off_beat_penalty: float = 3.0
    half_beat_penalty: float = 1.5
    snap_tolerance: float = 0.16  # s
    min_segment_beats: float = 0.9  # segments shorter than this (in beats) are absorbed
    silence_db: float = -50.0  # frames quieter than max(this, loud_level - 45 dB) -> N
    retune_threshold: float = 0.08  # semitones of detuning before the neural input is pitch-corrected
    fuse_deep_chroma: float = 0.5  # weight of the deep-chroma CRF in the maj/min decoder
    refine: RefineParams = field(default_factory=lambda: DEFAULT_PARAMS)
    # "N" rescue (see _rescue_no_chord)
    rescue_min_seconds: float = 1.0
    rescue_min_ll: float = -3.0
    rescue_min_margin: float = 1.5
    # dsp recognizer
    dsp_change_penalty: float = 9.0
    dsp_bass_weight: float = 0.6


DEFAULT = Params()

#: maj (0..11) / min (12..23) triad templates, rows ordered like the CRF classes
_MAJMIN_TEMPLATES = np.array([[1.0 if (pc - r) % 12 in ((0, 4, 7) if q == 0 else (0, 3, 7)) else 0.0
                               for pc in range(12)] for q in (0, 1) for r in range(12)])


_CALLBACK_MARK = "_chords_engine_from_progress"


def is_callback_error(exc: BaseException) -> bool:
    """True if ``exc`` was raised by the caller's progress callback (e.g. to cancel a job)."""
    return bool(getattr(exc, _CALLBACK_MARK, False))


class _Progress:
    """Monotonic progress reporting, always called from the analyzing thread.

    Exceptions raised by the callback propagate unchanged: raising from the callback is
    how a caller cancels an analysis.
    """

    def __init__(self, fn: Optional[ProgressFn]):
        self.fn = fn
        self.last = 0.0

    def __call__(self, frac: float, msg: str) -> None:
        frac = float(min(max(frac, self.last), 1.0))
        self.last = frac
        if self.fn is not None:
            try:
                self.fn(frac, msg)
            except BaseException as exc:
                try:
                    setattr(exc, _CALLBACK_MARK, True)
                except Exception:  # pragma: no cover - exceptions without __dict__
                    pass
                raise


# ----------------------------------------------------------------------------------------
# public entry


def analyze_signal(x: np.ndarray, progress: Optional[ProgressFn] = None, options: Optional[dict] = None,
                   params: Params = DEFAULT) -> dict:
    """Analyze mono float32 audio at 44.1 kHz. See docs/SPEC.md for the result shape."""
    from . import neural

    options = options or {}
    prog = progress if isinstance(progress, _Progress) else _Progress(progress)
    t_start = time.perf_counter()
    duration = len(x) / SR
    backend = str(options.get("backend") or os.environ.get("CHORDS_ENGINE_BACKEND") or "auto").lower()
    if backend == "neural" and not neural.available():
        raise EngineError("the neural backend (madmom) is not installed", code="internal")
    use_neural = backend in ("auto", "neural") and neural.available()

    peak = float(np.max(np.abs(x))) if len(x) else 0.0
    if duration < MIN_DURATION or peak < 1e-4:
        prog(1.0, "Done")
        return _trivial_result(x, duration)

    result = None
    if use_neural:
        try:
            result = _analyze_neural(x, duration, prog, params)
        except EngineError:
            raise
        except Exception as exc:
            if backend == "neural" or is_callback_error(exc):
                raise
            log.exception("neural analysis failed, falling back to the DSP pipeline")
    if result is None:
        result = _analyze_dsp(x, duration, prog, params)
    log.info("analyzed %.1fs of audio in %.2fs (%s)", duration, time.perf_counter() - t_start, result.get("_backend"))
    prog(1.0, "Done")
    return result


def _trivial_result(x: np.ndarray, duration: float) -> dict:
    duration = round(float(duration), 3)
    return {
        "duration": duration,
        "tempo": 120.0,
        "timeSignature": 4,
        "beats": [],
        "downbeats": [],
        "chords": [{"start": 0.0, "end": duration, "label": "N", "root": None, "quality": None, "bass": None,
                    "confidence": 1.0}] if duration > 0 else [],
        "key": {"tonic": "C", "mode": "major", "name": "C", "confidence": 0.0},
        "waveform": waveform_peaks(x),
        "_backend": "trivial",
    }


# ----------------------------------------------------------------------------------------
# neural pipeline


@dataclass
class NeuralFeatures:
    cnn_feat: np.ndarray  # (T, 128) at CHORD_FPS
    dc: np.ndarray  # (T, 12) deep chroma
    key_probs: np.ndarray  # (24,)
    rhythm: Rhythm
    chroma: ChromaFeatures
    silent: np.ndarray  # (T,) bool


def neural_features(x: np.ndarray, prog: Optional[_Progress] = None, params: Params = DEFAULT) -> NeuralFeatures:
    from . import neural

    prog = prog or _Progress(None)
    prog(0.02, "Loading models")
    neural.ensure_loaded()
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="chords-engine") as ex:
        fut_beats: Future = ex.submit(_neural_rhythm, x)
        y22 = to_22k(x)
        tuning = estimate_tuning(y22)
        fut_dsp: Future = ex.submit(chroma_features, y22, tuning)
        prog(0.06, "Computing spectrograms")
        n_frames = int(np.ceil(len(x) / (SR // neural.CHORD_FPS)))
        if abs(tuning) >= params.retune_threshold:
            xt, factor = neural.retune(x, tuning)
        else:
            xt, factor = x, 1.0
        spectra = neural.chord_spectra(xt)
        prog(0.14, "Computing chord features")
        cnn_feat = neural.chord_cnn_features(spectra.cnn)
        dc = neural.deep_chroma(spectra.dc)
        key_probs = neural.key_probabilities(spectra.dc)
        if factor != 1.0:
            cnn_feat = neural.to_original_grid(cnn_feat, factor, n_frames)
            dc = neural.to_original_grid(dc, factor, n_frames)
        prog(0.4, "Tracking beats")
        rhythm: Rhythm = fut_beats.result()
        prog(0.62, "Analyzing harmony")
        chroma: ChromaFeatures = fut_dsp.result()
    silent = _silent_frames(frame_rms_db(x, SR, neural.CHORD_FPS, len(cnn_feat)), params.silence_db)
    return NeuralFeatures(cnn_feat, dc, key_probs, rhythm, chroma, silent)


def neural_decode(f: NeuralFeatures, duration: float, params: Params = DEFAULT,
                  prog: Optional[_Progress] = None) -> tuple[list[tuple[float, float, Chord, float]], dict]:
    """Chord segments + key from pre-computed neural features."""
    from . import neural

    prog = prog or _Progress(None)
    fps = neural.CHORD_FPS
    T = len(f.cnn_feat)
    rhythm = f.rhythm
    crf = neural.crf_params("cnn")
    U = f.cnn_feat.astype(np.float64) @ crf["W"] + crf["c"]
    A, pi, tau = crf["A"], crf["pi"], crf["tau"]
    if params.fuse_deep_chroma > 0:
        dcrf = neural.crf_params("dc")
        lam = params.fuse_deep_chroma
        U = (1 - lam) * U + lam * (f.dc.astype(np.float64) @ dcrf["W"] + dcrf["c"])
        A = (1 - lam) * A + lam * dcrf["A"]
        pi = (1 - lam) * pi + lam * dcrf["pi"]
        tau = (1 - lam) * tau + lam * dcrf["tau"]
    U[f.silent, 24] += 25.0

    pen = dec.change_penalties(T, fps, rhythm.beats, params.off_beat_penalty, params.half_beat_penalty)
    path = dec.viterbi(U, A, pi, tau, pen)
    post = dec.posteriors(U, A, pi, tau, pen)
    segs = _postprocess(path, post, fps, duration, rhythm, params)
    _rescue_no_chord(segs, f, params)
    segs = dec.merge_equal(segs)
    prog(0.84, "Refining chord qualities")

    ev = Evidence(dc=f.dc, dc_times=np.arange(len(f.dc)) / fps, treble=f.chroma.treble, bass=f.chroma.bass,
                  times=f.chroma.times)

    def coarse_of(state: int) -> Chord:
        return NO_CHORD if state == 24 else Chord(state % 12, "maj" if state < 12 else "min")

    chords = _refine(segs, coarse_of, ev, rhythm, params)
    prog(0.93, "Detecting key")
    voiced = f.dc[~f.silent] if (~f.silent).any() else f.dc
    key = detect_key([(c, e - s) for s, e, c, _ in chords], chroma_mean=voiced.mean(axis=0) if len(voiced) else None,
                     cnn_probs=f.key_probs)
    return chords, key


def _rescue_no_chord(segs: list[dec.Segment], f: NeuralFeatures, params: Params) -> None:
    """Relabel audible "N" segments whose deep chroma unambiguously shows a triad.

    The chord CNN rejects unusual timbres (pure tones, simple synths) as no-chord; the
    deep chroma still sees the pitch classes. Real no-chord passages (drums, noise,
    speech, single-line riffs) score far below the threshold with no clear winner.
    """
    M = _MAJMIN_TEMPLATES
    for seg in segs:
        if seg.state != 24 or seg.duration < params.rescue_min_seconds:
            continue
        a, b = seg.first, max(seg.last, seg.first + 1)
        if f.silent[a:b].mean() > 0.3:
            continue
        ll = bernoulli_scores(deep_chroma_probabilities(f.dc[a:b]), M).mean(axis=0)
        order = np.argsort(ll)
        k, runner_up = int(order[-1]), float(ll[order[-2]])
        if ll[k] > params.rescue_min_ll and ll[k] - runner_up > params.rescue_min_margin:
            seg.state = k
            seg.confidence = float(np.clip(0.5 + 0.1 * (ll[k] - runner_up), 0.5, 0.9))


def _analyze_neural(x: np.ndarray, duration: float, prog: _Progress, params: Params) -> dict:
    feats = neural_features(x, prog, params)
    prog(0.72, "Decoding chords")
    chords, key = neural_decode(feats, duration, params, prog)
    return _assemble(x, duration, feats.rhythm, chords, key, backend="neural")


def _neural_rhythm(x: np.ndarray) -> Rhythm:
    from . import neural

    act = neural.beat_activations(neural.beat_features(x))
    res = neural.track_downbeats(act)
    if res is None or len(res) < 2:
        return Rhythm(np.zeros(0), np.zeros(0), 4, 0.0, "dbn")
    return from_dbn(res)


# ----------------------------------------------------------------------------------------
# DSP pipeline


def _dsp_vocabulary() -> tuple[list[Chord], np.ndarray, np.ndarray]:
    chords = [Chord(r, q) for q in ENGINE_QUALITIES for r in range(12)]
    M = np.zeros((len(chords), 12))
    prior = np.zeros(len(chords))
    for i, c in enumerate(chords):
        M[i, list(c.pitch_classes())] = 1.0
        prior[i] = DEFAULT_PARAMS.priors.get(c.quality, -1.5)
    return chords, M, prior


def _analyze_dsp(x: np.ndarray, duration: float, prog: _Progress, params: Params) -> dict:
    prog(0.04, "Resampling")
    y = to_22k(x)
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="chords-engine") as ex:
        fut = ex.submit(librosa_rhythm, y)
        prog(0.1, "Computing chroma")
        chroma = chroma_features(y)
        prog(0.5, "Tracking beats")
        rhythm = fut.result()
    prog(0.6, "Decoding chords")
    fps = chroma.fps
    T = len(chroma.times)
    vocab, M, prior = _dsp_vocabulary()
    K = len(vocab) + 1  # + N
    U = np.empty((T, K))
    U[:, :-1] = bernoulli_scores(chroma_probabilities(chroma.treble), M) + prior
    bass = chroma.bass / np.maximum(chroma.bass.sum(axis=1, keepdims=True), 1e-9)
    roots = np.array([c.root for c in vocab])
    U[:, :-1] += params.dsp_bass_weight * np.log(bass[:, roots] + 0.08)
    # N wins on (near) silence and when no chord explains the frame well
    silent = _silent_frames(frame_rms_db(x, SR, fps, T), params.silence_db)
    U[:, -1] = np.max(U[:, :-1], axis=1) - 4.0
    U[silent, -1] += 30.0
    trans = np.full((K, K), -params.dsp_change_penalty)
    np.fill_diagonal(trans, 0.0)
    pen = dec.change_penalties(T, fps, rhythm.beats, params.off_beat_penalty, params.half_beat_penalty)
    path = dec.viterbi(U, trans, change_pen=pen)
    post = dec.posteriors(U, trans, change_pen=pen)
    segs = _postprocess(path, post, fps, duration, rhythm, params)
    prog(0.8, "Refining chords")

    ev = Evidence(dc=None, dc_times=None, treble=chroma.treble, bass=chroma.bass, times=chroma.times)

    def coarse_of(state: int) -> Chord:
        return NO_CHORD if state == K - 1 else vocab[state]

    chords = _refine(segs, coarse_of, ev, rhythm, params, fixed_quality=True)
    if len(rhythm.beats) >= 4:
        downs, meter = choose_meter(rhythm.beats, [s for s, _, c, _ in chords[1:]])
        rhythm = Rhythm(rhythm.beats, downs, meter, rhythm.tempo, rhythm.source)
    prog(0.92, "Detecting key")
    voiced = chroma.treble[~silent] if (~silent).any() else chroma.treble
    key = detect_key([(c, e - s) for s, e, c, _ in chords], chroma_mean=voiced.mean(axis=0) if len(voiced) else None)
    return _assemble(x, duration, rhythm, chords, key, backend="dsp")


# ----------------------------------------------------------------------------------------
# shared post-processing


def _silent_frames(rms_db: np.ndarray, floor_db: float) -> np.ndarray:
    if len(rms_db) == 0:
        return np.zeros(0, dtype=bool)
    loud = float(np.percentile(rms_db, 95))
    return rms_db < max(floor_db, loud - 45.0)


def _postprocess(path: np.ndarray, post: np.ndarray, fps: float, duration: float, rhythm: Rhythm,
                 params: Params) -> list[dec.Segment]:
    segs = dec.path_to_segments(path, fps, duration)
    segs = dec.snap_boundaries(segs, rhythm.beats, params.snap_tolerance)
    segs = dec.merge_equal(segs)
    min_dur = params.min_segment_beats * (rhythm.ibi if len(rhythm.beats) >= 2 else 0.5)

    def score(seg: dec.Segment, state: int) -> float:
        return float(post[seg.first:max(seg.last, seg.first + 1), state].mean())

    segs = dec.absorb_short(segs, min_dur, score)
    segs = dec.merge_equal(segs)
    for s in segs:
        s.confidence = score(s, s.state)
    return segs


def _refine(segs: list[dec.Segment], coarse_of, ev: Evidence, rhythm: Rhythm, params: Params,
            fixed_quality: bool = False) -> list[tuple[float, float, Chord, float]]:
    beats = rhythm.beats
    ibi = rhythm.ibi if len(beats) >= 2 else 0.5
    out: list[list] = []
    for seg in segs:
        coarse = coarse_of(seg.state)
        if fixed_quality and not coarse.is_none:
            rp = RefineParams(**{**params.refine.__dict__, "priors": {coarse.quality: 0.0}})
            parts = refine_segment(ev, seg.start, seg.end, coarse, beats, ibi, rp, candidates=(coarse.quality,))
        else:
            parts = refine_segment(ev, seg.start, seg.end, coarse, beats, ibi, params.refine)
        for a, b, chord in parts:
            conf = seg.confidence
            if not chord.is_none and (chord.quality not in ("maj", "min") or chord.bass is not None):
                conf *= EXTENDED_CONFIDENCE  # richer labels are less certain than the maj/min class
            if out and out[-1][2] == chord:  # merge identical neighbours
                w0, w1 = out[-1][1] - out[-1][0], b - a
                out[-1][3] = (out[-1][3] * w0 + conf * w1) / max(w0 + w1, 1e-9)
                out[-1][1] = b
            else:
                out.append([a, b, chord, conf])
    return [tuple(o) for o in out]


def _assemble(x: np.ndarray, duration: float, rhythm: Rhythm, chords: list, key: dict, backend: str) -> dict:
    segs = []
    for s, e, c, conf in chords:
        s, e = float(max(0.0, s)), float(min(duration, e))
        if e - s <= 1e-6:
            continue
        segs.append({"start": round(s, 3), "end": round(e, 3), **c.to_dict(),
                     "confidence": round(float(np.clip(conf, 0.0, 1.0)), 3)})
    if not segs:
        segs = [{"start": 0.0, "end": round(duration, 3), **NO_CHORD.to_dict(), "confidence": 1.0}]
    # exact contiguity and coverage of [0, duration]
    segs[0]["start"] = 0.0
    for a, b in zip(segs[:-1], segs[1:]):
        b["start"] = a["end"]
    segs[-1]["end"] = round(duration, 3)
    segs = [s for s in segs if s["end"] > s["start"]]
    beats = [round(float(b), 3) for b in rhythm.beats if 0 <= b <= duration]
    downbeats = [round(float(b), 3) for b in rhythm.downbeats if 0 <= b <= duration]
    tempo = rhythm.tempo if rhythm.tempo > 0 else tempo_from_beats(np.asarray(beats))
    return {
        "duration": round(float(duration), 3),
        "tempo": round(float(tempo), 2) if tempo > 0 else 120.0,
        "timeSignature": int(rhythm.time_signature),
        "beats": beats,
        "downbeats": downbeats,
        "chords": segs,
        "key": key,
        "waveform": waveform_peaks(x),
        "_backend": backend,
    }
