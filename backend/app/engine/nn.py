"""Fast, thread-safe inference for madmom's pre-trained networks.

madmom's own layer implementations run convolutions as one scipy call per
(input, output) channel pair and LSTMs as a Python loop per frame, which makes a
4-minute song take ~60 s. Here the weights are extracted once into immutable
arrays and evaluated with
  * convolutions as chunked im2col + BLAS matrix products,
  * LSTM recurrences as numba-compiled kernels (input projections batched up front),
which is numerically equivalent (verified against madmom in tests) and ~30x faster.

Nothing here keeps mutable state, so one loaded network can be shared by threads.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Callable, Sequence

import numpy as np
from numba import njit

DTYPE = np.float32

# ----------------------------------------------------------------------------------------
# activations


def _linear(x: np.ndarray) -> np.ndarray:
    return x


def _relu(x: np.ndarray) -> np.ndarray:
    return np.maximum(x, 0, out=x)


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 0.5 * np.tanh(0.5 * x) + 0.5


def _tanh(x: np.ndarray) -> np.ndarray:
    return np.tanh(x)


def _elu(x: np.ndarray) -> np.ndarray:
    return np.where(x > 0, x, np.expm1(np.minimum(x, 0)))


def _softmax(x: np.ndarray) -> np.ndarray:
    e = np.exp(x - np.max(x, axis=-1, keepdims=True))
    return e / np.sum(e, axis=-1, keepdims=True)


def _activation(fn) -> Callable[[np.ndarray], np.ndarray]:
    if fn is None:
        return _linear
    name = getattr(fn, "__name__", "")
    table = {"linear": _linear, "relu": _relu, "sigmoid": _sigmoid, "tanh": _tanh, "elu": _elu, "softmax": _softmax}
    if name not in table:
        raise ValueError(f"unsupported activation function {name!r}")
    return table[name]


# ----------------------------------------------------------------------------------------
# layers


class Op:
    def __call__(self, x: np.ndarray) -> np.ndarray:  # pragma: no cover - interface
        raise NotImplementedError


@dataclass(frozen=True)
class Dense(Op):
    weights: np.ndarray
    bias: np.ndarray
    act: Callable

    def __call__(self, x):
        return self.act(x @ self.weights + self.bias)


@dataclass(frozen=True)
class Conv2D(Op):
    """madmom ConvolutionalLayer ('valid' convolution, kernel flipped), input (T, F, C)."""

    kernel: np.ndarray  # (kt * kf * cin, cout), ordered to match the im2col layout
    bias: np.ndarray
    kt: int
    kf: int
    cin: int
    act: Callable
    max_chunk_elems: int = 6_000_000

    def __call__(self, x):
        if x.ndim == 2:
            x = x[:, :, None]
        x = np.ascontiguousarray(x, dtype=DTYPE)
        T, F, C = x.shape
        To, Fo = T - self.kt + 1, F - self.kf + 1
        cout = self.kernel.shape[1]
        out = np.empty((max(To, 0), max(Fo, 0), cout), dtype=DTYPE)
        if To <= 0 or Fo <= 0:
            return out
        # windows: (To, Fo, C, kt, kf)
        win = np.lib.stride_tricks.sliding_window_view(x, (self.kt, self.kf), axis=(0, 1))
        cols_per_row = self.kt * self.kf * C
        chunk = max(1, self.max_chunk_elems // max(1, Fo * cols_per_row))
        for s in range(0, To, chunk):
            e = min(To, s + chunk)
            cols = win[s:e].reshape((e - s) * Fo, cols_per_row)
            out[s:e] = (cols @ self.kernel).reshape(e - s, Fo, cout)
        out += self.bias
        return self.act(out)


@dataclass(frozen=True)
class BatchNorm(Op):
    scale: np.ndarray
    shift: np.ndarray
    act: Callable

    def __call__(self, x):
        return self.act(x * self.scale + self.shift)


@dataclass(frozen=True)
class MaxPool(Op):
    size: tuple[int, int]

    def __call__(self, x):
        st, sf = self.size
        T, F = x.shape[0], x.shape[1]
        To, Fo = T // st, F // sf
        x = x[: To * st, : Fo * sf]
        return x.reshape((To, st, Fo, sf) + x.shape[2:]).max(axis=(1, 3))


@dataclass(frozen=True)
class Pad(Op):
    width: int
    axes: tuple[int, ...]
    value: float

    def __call__(self, x):
        pad = [(0, 0)] * x.ndim
        for a in self.axes:
            pad[a] = (self.width, self.width)
        return np.pad(x, pad, mode="constant", constant_values=self.value)


@dataclass(frozen=True)
class Average(Op):
    axis: object

    def __call__(self, x):
        return np.mean(x, axis=self.axis)


@njit(cache=True, nogil=True, fastmath=True)
def _lstm_scan(xproj, rec, peep_i, peep_f, peep_o, h0, c0, reverse):  # pragma: no cover - compiled
    T = xproj.shape[0]
    H = rec.shape[0]
    out = np.empty((T, H), dtype=np.float32)
    h = h0.astype(np.float64).copy()
    c = c0.astype(np.float64).copy()
    g = np.empty(4 * H, dtype=np.float64)
    for step in range(T):
        t = T - 1 - step if reverse else step
        for k in range(4 * H):
            g[k] = xproj[t, k]
        for j in range(H):
            hj = h[j]
            for k in range(4 * H):
                g[k] += hj * rec[j, k]
        for j in range(H):
            ig = 0.5 * np.tanh(0.5 * (g[j] + c[j] * peep_i[j])) + 0.5
            fg = 0.5 * np.tanh(0.5 * (g[H + j] + c[j] * peep_f[j])) + 0.5
            cell = np.tanh(g[2 * H + j])
            c[j] = cell * ig + c[j] * fg
            og = 0.5 * np.tanh(0.5 * (g[3 * H + j] + c[j] * peep_o[j])) + 0.5
            h[j] = np.tanh(c[j]) * og
        for j in range(H):
            out[t, j] = h[j]
    return out


@dataclass(frozen=True)
class LSTM:
    """One direction of a madmom LSTMLayer (peephole LSTM, tanh cell/output, sigmoid gates)."""

    w_in: np.ndarray  # (D, 4H) gates [input, forget, cell, output]
    bias: np.ndarray  # (4H,)
    rec: np.ndarray  # (H, 4H)
    peep_i: np.ndarray
    peep_f: np.ndarray
    peep_o: np.ndarray
    h0: np.ndarray
    c0: np.ndarray

    def run(self, x: np.ndarray, reverse: bool) -> np.ndarray:
        xproj = np.ascontiguousarray(x @ self.w_in + self.bias, dtype=np.float32)
        return _lstm_scan(xproj, self.rec, self.peep_i, self.peep_f, self.peep_o, self.h0, self.c0, reverse)


@dataclass(frozen=True)
class BiLSTM(Op):
    fwd: LSTM
    bwd: LSTM

    def __call__(self, x):
        x = np.asarray(x, dtype=DTYPE)
        return np.hstack((self.fwd.run(x, False), self.bwd.run(x, True)))


@dataclass(frozen=True)
class FastNetwork:
    ops: tuple[Op, ...]

    def __call__(self, x: np.ndarray) -> np.ndarray:
        for op in self.ops:
            x = op(x)
        return x


# ----------------------------------------------------------------------------------------
# conversion from madmom objects


def _f32(a) -> np.ndarray:
    arr = np.ascontiguousarray(np.asarray(a, dtype=DTYPE))
    arr.setflags(write=False)
    return arr


def _convert_lstm(layer) -> LSTM:
    gates = (layer.input_gate, layer.forget_gate, layer.cell, layer.output_gate)
    H = layer.cell.bias.size
    zeros = np.zeros(H, dtype=np.float64)

    def peep(g):
        p = getattr(g, "peephole_weights", None)
        return zeros if p is None else np.asarray(p, dtype=np.float64).ravel()

    return LSTM(
        w_in=_f32(np.hstack([g.weights for g in gates])),
        bias=_f32(np.hstack([np.asarray(g.bias).ravel() for g in gates])),
        rec=np.ascontiguousarray(np.hstack([g.recurrent_weights for g in gates]), dtype=np.float64),
        peep_i=peep(layer.input_gate),
        peep_f=peep(layer.forget_gate),
        peep_o=peep(layer.output_gate),
        h0=np.asarray(getattr(layer, "init", zeros), dtype=np.float64).ravel().copy(),
        c0=np.asarray(getattr(layer, "cell_init", zeros), dtype=np.float64).ravel().copy(),
    )


def _convert_layer(layer) -> list[Op]:
    from madmom.ml.nn import layers as L

    name = type(layer).__name__
    if isinstance(layer, L.ConvolutionalLayer):
        if layer.pad != "valid" or layer.stride not in (None, 1, (1, 1)):
            raise ValueError("only stride-1 'valid' convolutions are supported")
        w = np.asarray(layer.weights, dtype=DTYPE)  # (cin, cout, kt, kf)
        cin, cout, kt, kf = w.shape
        flipped = w[:, :, ::-1, ::-1]  # true convolution
        # im2col layout from sliding_window_view: (C, kt, kf) per output pixel
        kernel = np.transpose(flipped, (0, 2, 3, 1)).reshape(cin * kt * kf, cout)
        bias = _f32(np.asarray(layer.bias).ravel())
        return [Conv2D(_f32(kernel), bias, kt, kf, cin, _activation(layer.activation_fn))]
    if isinstance(layer, L.BatchNormLayer):
        scale = np.asarray(layer.gamma) * np.asarray(layer.inv_std)
        shift = np.asarray(layer.beta) - np.asarray(layer.mean) * scale
        return [BatchNorm(_f32(scale), _f32(shift), _activation(layer.activation_fn))]
    if isinstance(layer, L.MaxPoolLayer):
        if getattr(layer, "axis", None) is not None or tuple(layer.stride) != tuple(layer.size):
            raise ValueError("unsupported max-pool configuration")
        return [MaxPool(tuple(int(s) for s in layer.size))]
    if isinstance(layer, L.PadLayer):
        return [Pad(int(layer.width), tuple(layer.axes), float(layer.value))]
    if isinstance(layer, L.AverageLayer):
        return [Average(layer.axis)]
    if isinstance(layer, L.BidirectionalLayer):
        if not isinstance(layer.fwd_layer, L.LSTMLayer) or not isinstance(layer.bwd_layer, L.LSTMLayer):
            raise ValueError("only bidirectional LSTM layers are supported")
        return [BiLSTM(_convert_lstm(layer.fwd_layer), _convert_lstm(layer.bwd_layer))]
    if type(layer) is L.FeedForwardLayer:
        return [Dense(_f32(layer.weights), _f32(np.asarray(layer.bias).ravel()), _activation(layer.activation_fn))]
    raise ValueError(f"unsupported madmom layer {name}")


def convert(network) -> FastNetwork:
    ops: list[Op] = []
    for layer in network.layers:
        ops.extend(_convert_layer(layer))
    return FastNetwork(tuple(ops))


_cache: dict[str, FastNetwork] = {}
_cache_lock = threading.Lock()


def load(path: str) -> FastNetwork:
    """Load (once, cached, thread-safe) a madmom network pickle as a FastNetwork."""
    with _cache_lock:
        net = _cache.get(path)
        if net is None:
            from madmom.ml.nn import NeuralNetwork

            net = convert(NeuralNetwork.load(path))
            _cache[path] = net
        return net


def load_ensemble(paths: Sequence[str]) -> list[FastNetwork]:
    return [load(p) for p in paths]


def warmup() -> None:
    """Compile the numba kernel ahead of the first real request."""
    H = 2
    _lstm_scan(np.zeros((3, 4 * H), np.float32), np.zeros((H, 4 * H)), np.zeros(H), np.zeros(H), np.zeros(H),
               np.zeros(H), np.zeros(H), False)
