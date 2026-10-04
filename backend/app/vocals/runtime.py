"""Torch runtime shared by the vocal models: device choice, CPU thread budget, a model cache and a
process-wide lock that lets one separation / pitch inference run at a time.

Heavy modules (torch, demucs, torchcrepe) are imported lazily inside the functions that need them.

Environment:
    CHORDS_VOCALS_DEVICE   auto (default: Apple MPS when available, else CPU) | cpu | mps | cuda
    CHORDS_VOCALS_THREADS  torch CPU threads (default: the CPUs this process may use, cgroup aware)
    CHORDS_VOCALS_CREPE    tiny (default) | full: the CREPE model (full is ~7x slower, not more accurate here)
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from typing import Any, Callable, Iterator, Optional

log = logging.getLogger("chords.vocals")

_models_lock = threading.Lock()
_models: dict[tuple[str, str], Any] = {}
_run_lock = threading.Lock()
_configured = False


def cpu_budget() -> int:
    """CPUs this process may use: ``CHORDS_VOCALS_THREADS``, else min(cpu_count, Apple performance cores,
    affinity, cgroup quota) — e.g. 4 on a 4-vCPU Cloud Run instance, 8 on an M4 Pro."""
    raw = os.environ.get("CHORDS_VOCALS_THREADS", "").strip()
    if raw.isdigit() and int(raw) > 0:
        return int(raw)
    n = os.cpu_count() or 1
    if sys.platform == "darwin":  # Apple silicon: the performance cores (efficiency cores slow torch down)
        try:
            perf = subprocess.run(["sysctl", "-n", "hw.perflevel0.physicalcpu"], capture_output=True, text=True,
                                  timeout=2).stdout.strip()
            if perf.isdigit() and int(perf) > 0:
                n = min(n, int(perf))
        except (OSError, subprocess.SubprocessError):
            pass
    if hasattr(os, "sched_getaffinity"):
        try:
            n = min(n, len(os.sched_getaffinity(0)))
        except OSError:  # pragma: no cover
            pass
    try:  # cgroup v2 CPU quota (containers, Cloud Run): "max 100000" or "<quota> <period>"
        quota, period = open("/sys/fs/cgroup/cpu.max").read().split()[:2]
        if quota != "max" and int(period) > 0:
            n = min(n, max(1, int(int(quota) / int(period) + 0.5)))
    except (OSError, ValueError):
        pass
    return max(1, n)


def configure_torch() -> None:
    """Thread budget + inference-only defaults; idempotent, called before the first model load."""
    global _configured
    if _configured:
        return
    import torch

    threads = cpu_budget()
    if torch.get_num_threads() != threads:
        torch.set_num_threads(threads)
    _configured = True
    log.info("torch %s: %d CPU threads, MPS %s", torch.__version__, threads,
             "available" if torch.backends.mps.is_available() else "unavailable")


def device(preferred: Optional[str] = None) -> str:
    """The torch device to run on: ``preferred`` / ``CHORDS_VOCALS_DEVICE`` if usable, else MPS, else CPU."""
    import torch

    choice = (preferred or os.environ.get("CHORDS_VOCALS_DEVICE", "") or "auto").strip().lower()
    mps = torch.backends.mps.is_available()
    cuda = torch.cuda.is_available()
    if choice == "cpu":
        return "cpu"
    if choice == "mps":
        return "mps" if mps else "cpu"
    if choice == "cuda":
        return "cuda" if cuda else "cpu"
    return "cuda" if cuda else "mps" if mps else "cpu"


def cached_model(name: str, dev: str, loader: Callable[[], Any]) -> Any:
    """Load a model once per (name, device); later calls return the same (read-only) instance."""
    key = (name, dev)
    model = _models.get(key)
    if model is not None:
        return model
    with _models_lock:
        model = _models.get(key)
        if model is None:
            configure_torch()
            started = time.monotonic()
            model = loader()
            _models[key] = model
            log.info("loaded %s on %s in %.1fs", name, dev, time.monotonic() - started)
        return model


@contextmanager
def exclusive(wait: Callable[[], None]) -> Iterator[None]:
    """Run one heavy inference at a time in this process. While another one runs, ``wait()`` is called
    every 0.25 s (it may raise to cancel)."""
    while not _run_lock.acquire(timeout=0.25):
        wait()
    try:
        yield
    finally:
        _run_lock.release()
