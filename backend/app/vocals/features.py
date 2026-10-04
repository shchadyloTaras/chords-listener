"""Frame features of the 16 kHz vocal stem on the pitch tracker's 10 ms grid (numpy only)."""
from __future__ import annotations

import numpy as np
from scipy.ndimage import maximum_filter1d

from .audio import PITCH_SR
from .pitch import HOP, frame_rms_db, n_frames

__all__ = ["frame_rms_db", "onset_strength"]

N_FFT = 512  # 32 ms
FLUX_LAG = 2  # frames (20 ms) between the compared spectra
FLUX_MAXFILT = 3  # bins; a max filter across frequency suppresses flux caused by vibrato
FLUX_BAND = (80.0, 5000.0)


def onset_strength(x16: np.ndarray, block: int = 4096) -> np.ndarray:
    """SuperFlux-style onset strength: positive log-spectral difference against the frequency
    max-filtered spectrum ``FLUX_LAG`` frames earlier, summed over 80 Hz–5 kHz. Shape (T,)."""
    t = n_frames(len(x16))
    padded = np.pad(np.asarray(x16, dtype=np.float32), (N_FFT // 2, N_FFT // 2))
    frames = np.lib.stride_tricks.sliding_window_view(padded, N_FFT)[::HOP][:t]
    window = np.hanning(N_FFT).astype(np.float32)
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / PITCH_SR)
    band = (freqs >= FLUX_BAND[0]) & (freqs <= FLUX_BAND[1])
    logmag = np.empty((t, int(band.sum())), dtype=np.float32)
    for s in range(0, t, block):
        spec = np.abs(np.fft.rfft(frames[s:s + block] * window, axis=1))[:, band]
        logmag[s:s + block] = np.log1p(100.0 * spec)
    ref = maximum_filter1d(logmag, size=FLUX_MAXFILT, axis=1)
    flux = np.zeros(t, dtype=np.float32)
    if t > FLUX_LAG:
        flux[FLUX_LAG:] = np.maximum(logmag[FLUX_LAG:] - ref[:-FLUX_LAG], 0.0).sum(axis=1)
    return flux
