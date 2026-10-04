"""The current user of a request (cloud mode, docs/CLOUD.md).

``AuthMiddleware`` sets the uid for every authenticated request; storage helpers
(``TrackStore.track_dir`` & co.) resolve paths for it. Background jobs submitted through
``JobManager`` capture the context at submission and run with the same uid. Code that starts
its own threads must do the same, e.g. ``threading.Thread(target=contextvars.copy_context().run,
args=(fn,))`` or ``with user_context(uid): ...``.

Local mode (``CHORDS_AUTH=off``) never sets a uid: ``current_uid()`` is None and the legacy
single-user layout ``<data>/tracks`` is used.
"""
from __future__ import annotations

import contextvars
import re
from contextlib import contextmanager
from typing import Iterator, Optional

SMOKE_UID = "smoke-test"
"""The uid the ``X-Smoke-Key`` header maps to (deployment smoke tests)."""

_UID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_current: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("chords_uid", default=None)


class NoUserContext(RuntimeError):
    """A per-user path was requested in cloud mode outside an authenticated request or job."""


def valid_uid(uid: Optional[str]) -> bool:
    """Firebase uids we accept as path components (letters, digits, ``_`` and ``-``, ≤128 chars)."""
    return bool(uid and _UID_RE.fullmatch(uid))


def current_uid() -> Optional[str]:
    return _current.get()


def set_current_uid(uid: Optional[str]) -> contextvars.Token:
    if uid is not None and not valid_uid(uid):
        raise ValueError("invalid uid")
    return _current.set(uid)


def reset_current_uid(token: contextvars.Token) -> None:
    _current.reset(token)


@contextmanager
def user_context(uid: Optional[str]) -> Iterator[None]:
    """Run a block as ``uid`` (e.g. a maintenance task or a test)."""
    token = set_current_uid(uid)
    try:
        yield
    finally:
        reset_current_uid(token)
