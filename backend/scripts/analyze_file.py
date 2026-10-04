"""Print a readable chord sheet (by bars) plus key / tempo for any audio or video file.

Usage (from backend/):
    uv run python scripts/analyze_file.py FILE [--segments] [--json OUT] [--backend auto|neural|dsp]
                                               [--bars-per-line 4] [--simple]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine import analyze, engine_info  # noqa: E402


def fmt_time(t: float) -> str:
    m, s = divmod(max(t, 0.0), 60)
    return f"{int(m)}:{s:04.1f}"


def simplify(label: str) -> str:
    """Reduce to maj/min triad (drop extensions and slash bass)."""
    if label == "N":
        return label
    base = label.split("/")[0]
    root = base[:2] if len(base) > 1 and base[1] == "#" else base[:1]
    suffix = base[len(root):]
    return root + ("m" if suffix.startswith("m") and not suffix.startswith("maj") else "")


def bar_lines(res: dict, bars_per_line: int, simple: bool) -> list[str]:
    chords = res["chords"]
    downs = list(res["downbeats"])
    dur = res["duration"]
    if len(downs) < 2:  # no meter information: fall back to 4-beat groups or 2-second cells
        step = 4 * 60.0 / res["tempo"] if res["tempo"] else 2.0
        downs = [i * step for i in range(int(dur / step) + 1)]
    if downs[0] > 0.05:
        downs = [0.0] + downs  # pickup / intro before the first downbeat
    edges = downs + [dur]
    min_overlap = 0.4 * (60.0 / res["tempo"] if res["tempo"] else 0.5)
    cells = []
    for a, b in zip(edges[:-1], edges[1:]):
        if b - a < 1e-3:
            continue
        labels = []
        for c in chords:
            ov = min(b, c["end"]) - max(a, c["start"])
            if ov >= min(min_overlap, (b - a) * 0.45):
                lab = simplify(c["label"]) if simple else c["label"]
                if not labels or labels[-1] != lab:
                    labels.append(lab)
        cells.append((a, " ".join(labels) if labels else "%"))
    width = max((len(c) for _, c in cells), default=4) + 2
    lines = []
    for i in range(0, len(cells), bars_per_line):
        row = cells[i:i + bars_per_line]
        lines.append(f"{fmt_time(row[0][0]):>7s} |" + "|".join(f" {c:<{width - 1}s}" for _, c in row) + "|")
    return lines


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file")
    ap.add_argument("--segments", action="store_true", help="also list every chord segment with times/confidence")
    ap.add_argument("--json", type=Path, help="write the raw analysis JSON here")
    ap.add_argument("--backend", default="auto", choices=["auto", "neural", "dsp"])
    ap.add_argument("--bars-per-line", type=int, default=4)
    ap.add_argument("--simple", action="store_true", help="show maj/min triads only")
    args = ap.parse_args()

    stages = []
    t0 = time.perf_counter()
    res = analyze(args.file, progress=lambda f, m: stages.append((round(time.perf_counter() - t0, 2), f, m)),
                  options={"backend": args.backend})
    dt = time.perf_counter() - t0
    key = res["key"]
    print(f"{Path(args.file).name}  ({fmt_time(res['duration'])})")
    print(f"key {key['name']} ({key['mode']}, conf {key['confidence']:.2f}) | {res['tempo']:.1f} BPM | "
          f"{res['timeSignature']}/4 | {len(res['chords'])} segments | {res['engine']} | analyzed in {dt:.2f}s")
    print()
    for line in bar_lines(res, args.bars_per_line, args.simple):
        print(line)
    if args.segments:
        print()
        for c in res["chords"]:
            span = f"{fmt_time(c['start']):>8s} - {fmt_time(c['end']):>8s}"
            print(f"{span}  {c['label']:<10s} conf {c['confidence']:.2f}")
    if args.json:
        args.json.write_text(json.dumps(res, indent=1))
        print(f"\nwrote {args.json}")
    info = engine_info()
    feats = ", ".join(k for k, v in info["features"].items() if v)
    print(f"\nfeatures: {feats}")


if __name__ == "__main__":
    main()
