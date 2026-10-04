"""Vocal pipeline exceptions. ``code`` is an API ``ErrorCode`` (frontend/src/types.ts)."""
from __future__ import annotations


class VocalsError(Exception):
    """User-facing failure of the vocal pipeline (``unavailable`` when the optional extra is missing)."""

    def __init__(self, message: str, code: str = "analysis_failed") -> None:
        super().__init__(message)
        self.code = code
