"""madmom-model front end: spectrogram pre-processing + pre-trained networks.

Reproduces madmom's processors (CNNChordFeatureProcessor, CRFChordRecognitionProcessor
potentials, DeepChromaProcessor, CNNKeyRecognitionProcessor, RNNDownBeatProcessor) with
vectorized, block-wise spectrograms (bounded memory for long files) and the fast network
runtime in :mod:`.nn`. Requires the optional ``madmom`` package (models ship with it).
"""
from __future__ import annotations

import importlib
import importlib.util
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import lru_cache
from typing import Optional

import numpy as np

from . import nn

SR = 44100
CHORD_FPS = 10
BEAT_FPS = 100
_BLOCK = 2048  # STFT frames per block

_lock = threading.Lock()


_loaded = False


def available() -> bool:
    return importlib.util.find_spec("madmom") is not None


def ensure_loaded() -> None:
    """Import madmom and load every model once, serialized.

    Importing madmom sub-modules concurrently from several threads can deadlock on
    Python's per-module import locks, so all imports happen here under one lock before
    any worker thread starts.
    """
    global _loaded
    if _loaded:
        return
    with _lock:
        if _loaded:
            return
        for module in ("madmom.audio.filters", "madmom.audio.spectrogram", "madmom.audio.stft", "madmom.ml.crf",
                       "madmom.ml.nn"):
            importlib.import_module(module)
        from madmom import models

        for paths in (models.CHORDS_CNN_FEAT, models.CHROMA_DNN, models.KEY_CNN, models.DOWNBEATS_BLSTM):
            nn.load_ensemble(paths)
        _crf("cnn")
        _crf("dc")
        from . import dbn

        nn.warmup()
        dbn.warmup()
        _loaded = True


# ----------------------------------------------------------------------------------------
# spectrograms


def _frames(x: np.ndarray, frame_size: int, hop: int, start: int, stop: int) -> np.ndarray:
    """madmom FramedSignal frames [start, stop) (origin 'center', zero padded), as a copy."""
    half = frame_size // 2
    lo = start * hop - half
    hi = (stop - 1) * hop - half + frame_size
    seg = np.zeros(hi - lo, dtype=np.float32)
    a, b = max(lo, 0), min(hi, len(x))
    if b > a:
        seg[a - lo:b - lo] = x[a:b]
    view = np.lib.stride_tricks.sliding_window_view(seg, frame_size)[::hop]
    return view[: stop - start]


@lru_cache(maxsize=16)
def _filterbank(frame_size: int, num_bands: int, fmin: float, fmax: float, norm: bool) -> np.ndarray:
    from madmom.audio.filters import LogarithmicFilterbank
    from madmom.audio.stft import fft_frequencies

    freqs = fft_frequencies(frame_size >> 1, SR)
    fb = LogarithmicFilterbank(freqs, num_bands=num_bands, fmin=fmin, fmax=fmax, fref=440.0,
                               norm_filters=norm, unique_filters=True)
    arr = np.ascontiguousarray(np.asarray(fb, dtype=np.float32))
    arr.setflags(write=False)
    return arr


@lru_cache(maxsize=8)
def _window(frame_size: int) -> np.ndarray:
    w = np.hanning(frame_size).astype(np.float32)
    w.setflags(write=False)
    return w


def log_filtered_specs(x: np.ndarray, frame_size: int, fps: int, bank_params: list[tuple]) -> list[np.ndarray]:
    """log10(1 + |STFT| @ filterbank) for each filterbank, computed block-wise."""
    hop = SR // fps
    n = int(np.ceil(len(x) / hop))
    banks = [_filterbank(frame_size, *p) for p in bank_params]
    outs = [np.empty((n, b.shape[1]), dtype=np.float32) for b in banks]
    win = _window(frame_size)
    nbins = frame_size >> 1
    for s in range(0, n, _BLOCK):
        e = min(n, s + _BLOCK)
        fr = _frames(x, frame_size, hop, s, e) * win
        mag = np.abs(np.fft.rfft(fr, axis=1)[:, :nbins]).astype(np.float32)
        for b, o in zip(banks, outs):
            np.log10(mag @ b + 1.0, out=o[s:e])
    return outs


@dataclass
class Spectra:
    cnn: np.ndarray  # (T10, 113) chord CNN input
    dc: np.ndarray  # (T10, 105) deep-chroma / key input


def chord_spectra(x: np.ndarray) -> Spectra:
    cnn, dc = log_filtered_specs(x, 8192, CHORD_FPS, [(24, 60.0, 2600.0, True), (24, 65.0, 2100.0, True)])
    return Spectra(cnn=cnn, dc=dc)


def beat_features(x: np.ndarray) -> np.ndarray:
    """Input of madmom's RNNDownBeatProcessor: [log spec, positive diff] for 3 frame sizes."""
    from madmom.audio.spectrogram import _diff_frames

    parts = []
    for frame_size, bands in ((1024, 3), (2048, 6), (4096, 12)):
        (spec,) = log_filtered_specs(x, frame_size, BEAT_FPS, [(bands, 30.0, 17000.0, True)])
        lag = _diff_frames(0.5, hop_size=SR // BEAT_FPS, frame_size=frame_size, window=np.hanning)
        diff = np.zeros_like(spec)
        diff[lag:] = spec[lag:] - spec[:-lag]
        np.maximum(diff, 0, out=diff)
        parts += [spec, diff]
    return np.hstack(parts)


def retune(x: np.ndarray, semitones: float) -> tuple[np.ndarray, float]:
    """Shift pitch by ``-semitones`` via resampling (the networks expect A440 tuning).

    Returns the new signal and the time factor ``f``: time ``t`` in the new signal
    corresponds to ``t / f`` in the original.
    """
    import soxr

    f = float(2.0 ** (semitones / 12.0))
    y = soxr.resample(x, SR, SR * f, quality="HQ").astype(np.float32)
    return y, f


def to_original_grid(frames: np.ndarray, factor: float, n_frames: int) -> np.ndarray:
    """Map frame-wise features of a retuned signal back onto the original frame grid."""
    idx = np.clip(np.round(np.arange(n_frames) * factor).astype(np.int64), 0, len(frames) - 1)
    return frames[idx]


# ----------------------------------------------------------------------------------------
# networks


def _models():
    from madmom import models

    return models


def chord_cnn_features(spec_cnn: np.ndarray, block: int = 600) -> np.ndarray:
    """128-dim learned chord features at 10 fps (Korzeniowski & Widmer, 2016)."""
    net = nn.load(_models().CHORDS_CNN_FEAT[0])
    T = len(spec_cnn)
    pad = np.zeros((11, spec_cnn.shape[1]), np.float32)
    padded = np.vstack([pad, spec_cnn, pad])
    out = np.empty((T, 128), dtype=np.float32)
    for s in range(0, T, block):
        e = min(T, s + block)
        act = net(padded[s:e + 22]).mean(axis=1)  # (n + 2, 128)
        out[s:e] = (act[:-2] + act[1:-1] + act[2:]) / 3.0
    return out


@lru_cache(maxsize=2)
def _crf(which: str):
    from madmom.ml.crf import ConditionalRandomField

    m = _models()
    path = m.CHORDS_CFCRF[0] if which == "cnn" else m.CHORDS_DCCRF[0]
    crf = ConditionalRandomField.load(path)
    # madmom classes: root index from A (0 = A), 0..11 maj, 12..23 min, 24 = N.
    # Re-order to this engine's convention: root index from C.
    perm = np.array([(r + 3) % 12 for r in range(12)] + [12 + (r + 3) % 12 for r in range(12)] + [24])
    # engine class k <- madmom class perm[k]
    return {
        "W": np.asarray(crf.W, np.float64)[:, perm],
        "c": np.asarray(crf.c, np.float64)[perm],
        "A": np.asarray(crf.A, np.float64)[np.ix_(perm, perm)],
        "pi": np.asarray(crf.pi, np.float64)[perm],
        "tau": np.asarray(crf.tau, np.float64)[perm],
    }


def crf_params(which: str = "cnn") -> dict:
    with _lock:
        return _crf(which)


def deep_chroma(spec_dc: np.ndarray) -> np.ndarray:
    """12-bin learned chroma (pitch-class probabilities of the sounding chord), 10 fps."""
    nets = nn.load_ensemble(_models().CHROMA_DNN)
    T, B = spec_dc.shape
    padded = np.vstack([np.zeros((7, B), np.float32), spec_dc, np.zeros((7, B), np.float32)])
    ctx = np.lib.stride_tricks.sliding_window_view(padded, (15, B))[:T, 0].reshape(T, 15 * B)
    out = np.zeros((T, 12), dtype=np.float32)
    for net in nets:
        for s in range(0, T, 4096):
            out[s:s + 4096] += net(np.ascontiguousarray(ctx[s:s + 4096]))
    out /= len(nets)
    return out  # bins are C, C#, ..., B


def key_probabilities(spec_dc: np.ndarray, max_frames: int = 1500) -> np.ndarray:
    """24 key probabilities (0..11 major from C, 12..23 minor from C) from the key CNN."""
    nets = nn.load_ensemble(_models().KEY_CNN)
    spec5 = spec_dc[::2]  # 5 fps, same spectrogram parameters as madmom's key processor
    if len(spec5) < 8:
        return np.full(24, 1.0 / 24)
    logits = np.zeros(24)
    total = 0
    for s in range(0, len(spec5), max_frames):
        part = spec5[s:s + max_frames]
        if len(part) < 8:
            continue
        acc = np.zeros(24)
        for net in nets:
            acc += net(part)
        logits += acc / len(nets) * len(part)
        total += len(part)
    logits /= max(total, 1)
    p = np.exp(logits - logits.max())
    p /= p.sum()
    # madmom order: A major, Bb major, ..., G# major, A minor, ..., G# minor
    maj, mnr = np.roll(p[:12], -3), np.roll(p[12:], -3)
    return np.concatenate([maj, mnr])


def beat_activations(features: np.ndarray, threads: int = 4) -> np.ndarray:
    """(T100, 2) beat / downbeat activations from the 8-network BLSTM ensemble."""
    nets = nn.load_ensemble(_models().DOWNBEATS_BLSTM)
    feats = np.ascontiguousarray(features, dtype=np.float32)
    with ThreadPoolExecutor(max_workers=max(1, threads)) as ex:
        outs = list(ex.map(lambda net: net(feats), nets))
    act = np.mean(outs, axis=0)
    return act[:, 1:]


def track_downbeats(act: np.ndarray, beats_per_bar: tuple[int, ...] = (3, 4)) -> Optional[np.ndarray]:
    """Bar-pointer DBN (madmom-equivalent, memory-lean) -> rows of (time, beat_number) or None."""
    from . import dbn

    res = dbn.track(act, BEAT_FPS, beats_per_bar=beats_per_bar)
    if res is None or len(res) == 0:
        return None
    return np.asarray(res, dtype=np.float64)
