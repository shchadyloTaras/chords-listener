"""Chord vocabulary and label convention (see docs/SPEC.md "Chord label convention").

Labels are ``<root><suffix>[/<bass>]`` with sharp spelling, or ``"N"`` for no chord.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

PITCH_NAMES: tuple[str, ...] = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")

_FLAT_TO_SHARP = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#",
                  "Cb": "B", "Fb": "E", "E#": "F", "B#": "C"}

#: canonical quality -> (intervals in semitones above the root, label suffix)
QUALITIES: dict[str, tuple[tuple[int, ...], str]] = {
    "maj": ((0, 4, 7), ""),
    "min": ((0, 3, 7), "m"),
    "7": ((0, 4, 7, 10), "7"),
    "maj7": ((0, 4, 7, 11), "maj7"),
    "min7": ((0, 3, 7, 10), "m7"),
    "dim": ((0, 3, 6), "dim"),
    "aug": ((0, 4, 8), "aug"),
    "sus2": ((0, 2, 7), "sus2"),
    "sus4": ((0, 5, 7), "sus4"),
    "dim7": ((0, 3, 6, 9), "dim7"),
    "hdim7": ((0, 3, 6, 10), "m7b5"),
    "6": ((0, 4, 7, 9), "6"),
    "min6": ((0, 3, 7, 9), "m6"),
    "9": ((0, 2, 4, 7, 10), "9"),
    "add9": ((0, 2, 4, 7), "add9"),
}

#: suffix -> quality, longest suffixes first so that parsing is unambiguous
_SUFFIX_TO_QUALITY = sorted(((suffix, q) for q, (_, suffix) in QUALITIES.items()), key=lambda x: -len(x[0]))

#: Qualities the engine itself emits (a deliberately conservative subset).
ENGINE_QUALITIES: tuple[str, ...] = ("maj", "min", "7", "maj7", "min7", "sus2", "sus4", "dim", "aug")

#: maj/min reduction used for evaluation and for the coarse decoder.
MAJMIN_OF: dict[str, Optional[str]] = {
    "maj": "maj", "7": "maj", "maj7": "maj", "6": "maj", "9": "maj", "add9": "maj",
    "min": "min", "min7": "min", "min6": "min",
    "dim": None, "aug": None, "sus2": None, "sus4": None, "dim7": None, "hdim7": None,
}


def pitch_class(name: str) -> int:
    """Return the pitch class (0 = C) of a note name such as ``"F#"`` or ``"Bb"``."""
    name = name.strip()
    name = _FLAT_TO_SHARP.get(name, name)
    return PITCH_NAMES.index(name)


@dataclass(frozen=True)
class Chord:
    """A chord symbol. ``root is None`` means no chord (``N``)."""

    root: Optional[int] = None
    quality: Optional[str] = None
    bass: Optional[int] = None  # pitch class of the bass if it differs from the root

    @property
    def is_none(self) -> bool:
        return self.root is None

    @property
    def label(self) -> str:
        return format_label(self.root, self.quality, self.bass)

    def pitch_classes(self) -> tuple[int, ...]:
        if self.root is None or self.quality is None:
            return ()
        return tuple((self.root + i) % 12 for i in QUALITIES[self.quality][0])

    def to_dict(self) -> dict:
        """Engine-contract fields (``label``/``root``/``quality``/``bass``)."""
        if self.root is None:
            return {"label": "N", "root": None, "quality": None, "bass": None}
        return {
            "label": self.label,
            "root": PITCH_NAMES[self.root],
            "quality": self.quality,
            "bass": PITCH_NAMES[self.bass] if self.bass is not None and self.bass != self.root else None,
        }


NO_CHORD = Chord()


def format_label(root: Optional[int], quality: Optional[str], bass: Optional[int] = None) -> str:
    if root is None or quality is None:
        return "N"
    label = PITCH_NAMES[root % 12] + QUALITIES[quality][1]
    if bass is not None and bass % 12 != root % 12:
        label += "/" + PITCH_NAMES[bass % 12]
    return label


def parse_label(label: str) -> Chord:
    """Parse a label in the SPEC convention (also accepts flats). ``"N"``/``"X"`` -> no chord."""
    label = label.strip()
    if label in ("", "N", "X"):
        return NO_CHORD
    bass_name = None
    if "/" in label:
        label, bass_name = label.split("/", 1)
    if len(label) > 1 and label[1] in "#b":
        root_name, suffix = label[:2], label[2:]
    else:
        root_name, suffix = label[:1], label[1:]
    root = pitch_class(root_name)
    quality = None
    for suf, q in _SUFFIX_TO_QUALITY:
        if suffix == suf:
            quality = q
            break
    if quality is None:
        raise ValueError(f"unknown chord suffix {suffix!r} in {label!r}")
    bass = pitch_class(bass_name) if bass_name else None
    if bass == root:
        bass = None
    return Chord(root, quality, bass)


def template(root: int, quality: str, weights: Optional[dict[int, float]] = None) -> np.ndarray:
    """Binary (or weighted) 12-bin pitch-class template of a chord."""
    t = np.zeros(12, dtype=np.float64)
    for interval in QUALITIES[quality][0]:
        t[(root + interval) % 12] = 1.0 if weights is None else weights.get(interval, 1.0)
    return t


def majmin_index(chord: Chord) -> int:
    """Index in the 25-class maj/min vocabulary (0..11 maj by root, 12..23 min, 24 = N)."""
    if chord.root is None or chord.quality is None:
        return 24
    reduced = MAJMIN_OF.get(chord.quality)
    if reduced == "min":
        return 12 + chord.root
    return chord.root
