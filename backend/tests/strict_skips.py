"""Skips CI must not accept (T59): the emulator workflow installs ffmpeg and starts the Firebase emulators, so a test
skipped for want of either means the run proved less than it claims (the AC-16 admission tests once skipped this way
and the job stayed green). With ``CHORDS_FAIL_ON_SKIP=1`` such a skip is reported as a failure; any other skip (an
optional extra CI does not install) stays a skip. ``conftest.py`` installs the hook."""
from __future__ import annotations

import os
import re
from typing import Any

import pytest

STRICT_ENV = "CHORDS_FAIL_ON_SKIP"
MUST_RUN = re.compile(r"ffmpeg|ffprobe|emulator", re.IGNORECASE)


def _reason(report: Any) -> str:
    longrepr = report.longrepr
    if isinstance(longrepr, tuple) and len(longrepr) == 3:  # (file, line, "Skipped: <reason>")
        return str(longrepr[2])
    return str(longrepr)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item: Any, call: Any):
    outcome = yield
    report = outcome.get_result()
    if not report.skipped or os.environ.get(STRICT_ENV) != "1" or hasattr(report, "wasxfail"):
        return
    reason = _reason(report)
    if MUST_RUN.search(reason):
        report.outcome = "failed"
        report.longrepr = f"{item.nodeid} must not be skipped here ({STRICT_ENV}=1): {reason}"
