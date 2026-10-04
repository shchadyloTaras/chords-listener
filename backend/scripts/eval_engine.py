"""Evaluate the chord engine on synthetic songs with known ground truth.

Usage (from backend/):
    uv run python scripts/eval_engine.py [--dir DIR] [--backend auto|neural|dsp] [--only NAME ...]

Without ``--dir`` the songs from scripts/make_synthetic.py are rendered into a temporary
directory (deleted afterwards). Metrics are frame-level (100 Hz), duration weighted:
  root     root pitch class (N must match N)
  majmin   maj/min/N reduction; frames whose reference is sus/dim/aug are excluded (as mir_eval)
  full     exact root + quality (bass ignored) over the engine vocabulary, all frames
  label    exact label incl. slash bass
plus key / time-signature correctness and beat F-measure (+-70 ms).
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from app.engine import analyze  # noqa: E402
from app.engine.chords import MAJMIN_OF, parse_label  # noqa: E402

RATE = 100.0


def _sample(chords: list[dict], duration: float) -> list:
    n = int(np.ceil(duration * RATE))
    out = [None] * n
    for c in chords:
        a = int(round(c["start"] * RATE))
        b = min(n, int(round(c["end"] * RATE)))
        ch = parse_label(c["label"])
        for i in range(max(a, 0), b):
            out[i] = ch
    return out


def _majmin(ch):
    if ch is None:
        return None
    if ch.is_none:
        return "N"
    red = MAJMIN_OF.get(ch.quality)
    return None if red is None else (ch.root, red)


def score(est: list[dict], ref: list[dict], duration: float) -> dict:
    """Frame-level scores of estimated vs. reference chord segments."""
    e, r = _sample(est, duration), _sample(ref, duration)
    n = min(len(e), len(r))
    root_hits = mm_hits = mm_total = full_hits = label_hits = total = 0
    for i in range(n):
        ri, ei = r[i], e[i]
        if ri is None:
            continue
        total += 1
        if ei is None:
            continue
        root_hits += ri.root == ei.root
        full_hits += (ri.root, ri.quality) == (ei.root, ei.quality)
        label_hits += ri == ei
        rm = _majmin(ri)
        if rm is not None:
            mm_total += 1
            em = _majmin(ei)
            mm_hits += em == rm
    total = max(total, 1)
    return {"root": root_hits / total, "majmin": mm_hits / max(mm_total, 1), "full": full_hits / total,
            "label": label_hits / total, "frames": total}


def beat_f(est: list[float], ref: list[float], tol: float = 0.07) -> float:
    if not est or not ref:
        return 0.0
    est_a, ref_a = np.asarray(est), np.asarray(ref)
    used = np.zeros(len(est_a), bool)
    hits = 0
    for b in ref_a:
        d = np.abs(est_a - b)
        d[used] = np.inf
        j = int(np.argmin(d))
        if d[j] <= tol:
            used[j] = True
            hits += 1
    p, rc = hits / len(est_a), hits / len(ref_a)
    return 0.0 if p + rc == 0 else 2 * p * rc / (p + rc)


def evaluate(directory: Path, backend: str, only: list[str] | None, verbose: bool) -> dict:
    rows = []
    for js in sorted(directory.glob("*.json")):
        truth = json.loads(js.read_text())
        name = truth.get("name", js.stem)
        if only and name not in only:
            continue
        wav = js.with_suffix(".wav")
        t0 = time.perf_counter()
        res = analyze(str(wav), options={"backend": backend})
        dt = time.perf_counter() - t0
        sc = score(res["chords"], truth["chords"], truth["duration"])
        sc.update(name=name, seconds=dt, duration=truth["duration"], key_ok=res["key"]["name"] == truth["key"],
                  key=res["key"]["name"], ts=res["timeSignature"], ts_ok=res["timeSignature"] == truth["timeSignature"],
                  beatF=beat_f(res["beats"], truth["beats"]), tempo=res["tempo"], engine=res["engine"])
        rows.append(sc)
        if verbose:
            print(f"--- {name}")
            print("  est:", " ".join(f"{c['label']}@{c['start']:.1f}" for c in res["chords"]))
            print("  ref:", " ".join(f"{c['label']}@{c['start']:.1f}" for c in truth["chords"]))
    return {"rows": rows}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", type=Path, help="directory with <name>.wav + <name>.json (default: render fresh)")
    ap.add_argument("--backend", default="auto", choices=["auto", "neural", "dsp"])
    ap.add_argument("--only", nargs="*")
    ap.add_argument("-v", "--verbose", action="store_true", help="print estimated vs. reference sequences")
    ap.add_argument("--json", type=Path, help="write the per-song results as JSON")
    args = ap.parse_args()

    tmp = None
    directory = args.dir
    if directory is None:
        from make_synthetic import SONGS, write_song

        tmp = tempfile.TemporaryDirectory(prefix="chords-eval-")
        directory = Path(tmp.name)
        for spec in SONGS:
            if not args.only or spec.name in args.only:
                write_song(spec, directory)
    try:
        out = evaluate(directory, args.backend, args.only, args.verbose)
    finally:
        if tmp is not None:
            tmp.cleanup()
    rows = out["rows"]
    if not rows:
        print("no songs evaluated")
        return
    hdr = (f"{'song':22s} {'root':>6s} {'majmin':>7s} {'full':>6s} {'label':>6s} {'key':>8s} {'ts':>4s} "
           f"{'beatF':>6s} {'bpm':>6s} {'sec':>6s}")
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        print(f"{r['name']:22s} {r['root']:6.3f} {r['majmin']:7.3f} {r['full']:6.3f} {r['label']:6.3f} "
              f"{r['key'] + ('' if r['key_ok'] else '*'):>8s} {str(r['ts']) + ('' if r['ts_ok'] else '*'):>4s} "
              f"{r['beatF']:6.3f} {r['tempo']:6.1f} {r['seconds']:6.2f}")
    w = np.array([r["frames"] for r in rows], dtype=float)
    avg = {k: float(np.sum(w * [r[k] for r in rows]) / w.sum()) for k in ("root", "majmin", "full", "label", "beatF")}
    total_audio = sum(r["duration"] for r in rows)
    total_time = sum(r["seconds"] for r in rows)
    print("-" * len(hdr))
    print(f"{'WEIGHTED MEAN':22s} {avg['root']:6.3f} {avg['majmin']:7.3f} {avg['full']:6.3f} {avg['label']:6.3f} "
          f"{sum(r['key_ok'] for r in rows)}/{len(rows):<5d} {sum(r['ts_ok'] for r in rows)}/{len(rows)} "
          f"{avg['beatF']:6.3f}")
    print(f"engine: {rows[0]['engine']}; analyzed {total_audio:.1f}s of audio in {total_time:.1f}s "
          f"({total_audio / max(total_time, 1e-9):.1f}x realtime)")
    if args.json:
        args.json.write_text(json.dumps({"rows": rows, "mean": avg}, indent=1))


if __name__ == "__main__":
    main()
