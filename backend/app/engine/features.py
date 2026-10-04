"""DSP features with librosa/numpy only: tuning-aware CQT -> note activations (NNLS-style
harmonic decomposition) -> treble chroma + bass chroma, onset envelope, beat tracking."""
from __future__ import annotations

import warnings
from dataclasses import dataclass
from functools import lru_cache

import numpy as np
from scipy.ndimage import median_filter, uniform_filter1d
from scipy.signal import resample_poly

# the CQT's low octaves use long windows; on very short clips librosa notes this, harmlessly
warnings.filterwarnings("ignore", message=r"n_fft=\d+ is too large", category=UserWarning, module=r"librosa")

SR = 22050
HOP = 2048  # ~10.8 fps
BINS_PER_SEMITONE = 3
FMIN_MIDI = 21  # A0
N_SEMITONES = 84  # A0 .. G#7
N_PARTIALS = 8
PARTIAL_DECAY = 0.7


@dataclass
class ChromaFeatures:
    times: np.ndarray  # frame centers (s)
    treble: np.ndarray  # (T, 12) normalized-ish chroma of the harmonic content
    bass: np.ndarray  # (T, 12) bass-register chroma
    notes: np.ndarray  # (T, 84) note activations A0..G#7
    energy: np.ndarray  # (T,) harmonic energy (sum of note activations)
    tuning: float  # in fractions of a semitone
    fps: float


def to_22k(x44: np.ndarray) -> np.ndarray:
    return resample_poly(x44, 1, 2).astype(np.float32)


def estimate_tuning(y: np.ndarray, sr: int = SR) -> float:
    """Deviation from A440 equal temperament in semitones, in [-0.5, 0.5)."""
    import librosa

    # a central excerpt keeps this cheap for long files
    max_len = 90 * sr
    if len(y) > max_len:
        mid = len(y) // 2
        y = y[mid - max_len // 2: mid + max_len // 2]
    if len(y) < sr // 2 or np.max(np.abs(y)) < 1e-4:
        return 0.0
    try:
        t = float(librosa.estimate_tuning(y=y, sr=sr, bins_per_octave=12))  # semitones
    except Exception:  # pragma: no cover - librosa edge cases on degenerate input
        return 0.0
    return float(np.clip(t if np.isfinite(t) else 0.0, -0.5, 0.5))


@lru_cache(maxsize=4)
def _note_dictionary(n_partials: int = N_PARTIALS, decay: float = PARTIAL_DECAY) -> np.ndarray:
    """(84 semitone bins, 84 notes) harmonic templates for the decomposition."""
    W = np.zeros((N_SEMITONES, N_SEMITONES))
    for n in range(N_SEMITONES):
        for k in range(1, n_partials + 1):
            b = n + 12.0 * np.log2(k)
            lo = int(np.floor(b))
            frac = b - lo
            amp = decay ** (k - 1)
            if lo < N_SEMITONES:
                W[lo, n] += amp * (1 - frac)
            if frac > 0 and lo + 1 < N_SEMITONES:
                W[lo + 1, n] += amp * frac
    W /= np.linalg.norm(W, axis=0, keepdims=True)
    W.setflags(write=False)
    return W


def _treble_bass_profiles() -> tuple[np.ndarray, np.ndarray]:
    midi = FMIN_MIDI + np.arange(N_SEMITONES)
    # treble: C3..C7 with soft edges; bass: E1..G3 peaking around A1-D2
    treble = np.clip((midi - 44) / 8.0, 0, 1) * np.clip((100 - midi) / 12.0, 0, 1)
    bass = np.exp(-0.5 * ((midi - 40.0) / 6.0) ** 2) * (midi <= 57) * (midi >= 26)
    return treble, bass


def chroma_features(y22: np.ndarray, tuning: float | None = None, percussive_filter: int = 5) -> ChromaFeatures:
    """Note activations and chroma from a 22.05 kHz mono signal."""
    import librosa

    if tuning is None:
        tuning = estimate_tuning(y22)
    fmin = librosa.midi_to_hz(FMIN_MIDI + tuning) * 2 ** (-1.0 / 36)  # centre bin on the semitone
    n_bins = N_SEMITONES * BINS_PER_SEMITONE
    n_frames_min = 1 + len(y22) // HOP
    if len(y22) < HOP * 2:
        y22 = np.pad(y22, (0, HOP * 2 - len(y22)))
    C = np.abs(librosa.cqt(y22, sr=SR, hop_length=HOP, fmin=fmin, n_bins=n_bins,
                           bins_per_octave=12 * BINS_PER_SEMITONE, filter_scale=1.0, sparsity=0.01,
                           res_type="soxr_hq")).astype(np.float64)
    C = C[:, :n_frames_min] if C.shape[1] > n_frames_min else C
    if percussive_filter > 1 and C.shape[1] > percussive_filter:
        C = median_filter(C, size=(1, percussive_filter), mode="nearest")
    # semitone spectrum: max over the 3 sub-bins (robust to residual mistuning)
    S = C.reshape(N_SEMITONES, BINS_PER_SEMITONE, -1).max(axis=1)
    S = np.sqrt(S)
    # spectral whitening: remove the slowly varying background (per frame)
    bg = uniform_filter1d(S, size=18, axis=0, mode="nearest")
    S = np.maximum(S - 0.6 * bg, 0.0)
    # NNLS-style decomposition with multiplicative updates (fixed dictionary)
    W = _note_dictionary()
    H = np.maximum(W.T @ S, 1e-9)
    WtV = W.T @ S
    WtW = W.T @ W
    for _ in range(40):
        H *= WtV / (WtW @ H + 1e-9)
    notes = H.T  # (T, 84)
    treble_w, bass_w = _treble_bass_profiles()
    pcs = (FMIN_MIDI + np.arange(N_SEMITONES)) % 12
    fold = np.zeros((N_SEMITONES, 12))
    fold[np.arange(N_SEMITONES), pcs] = 1.0
    treble = notes @ (fold * treble_w[:, None])
    bass = notes @ (fold * bass_w[:, None])
    energy = notes.sum(axis=1)
    times = np.arange(notes.shape[0]) * HOP / SR
    return ChromaFeatures(times=times, treble=treble, bass=bass, notes=notes, energy=energy, tuning=float(tuning),
                          fps=SR / HOP)


def onset_envelope(y22: np.ndarray) -> tuple[np.ndarray, float]:
    import librosa

    hop = 512
    env = librosa.onset.onset_strength(y=y22, sr=SR, hop_length=hop, aggregate=np.median)
    return env, SR / hop


def track_beats(y22: np.ndarray) -> tuple[np.ndarray, float]:
    """librosa beat tracking -> (beat times, tempo bpm)."""
    import librosa

    env, fps = onset_envelope(y22)
    if len(env) < 8 or float(np.max(env)) <= 1e-6:
        return np.zeros(0), 0.0
    tempo, beats = librosa.beat.beat_track(onset_envelope=env, sr=SR, hop_length=512, units="time", trim=True)
    tempo = float(np.atleast_1d(tempo)[0]) if np.size(tempo) else 0.0
    return np.asarray(beats, dtype=np.float64), tempo
