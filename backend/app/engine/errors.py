"""Engine exceptions. ``code`` is one of the API ``ErrorCode`` values (docs/SPEC.md)."""
from __future__ import annotations


class EngineError(Exception):
    """Raised for user-facing analysis failures (e.g. undecodable input)."""

    def __init__(self, message: str, code: str = "analysis_failed"):
        super().__init__(message)
        self.code = code
