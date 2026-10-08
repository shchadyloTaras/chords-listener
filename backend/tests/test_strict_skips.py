"""CI must not go green on tests that silently skipped (T59): with ``CHORDS_FAIL_ON_SKIP=1`` (set by the emulator
workflow) a test skipped for want of ffmpeg or a Firebase emulator fails instead; other skips (an optional extra that
CI does not install) stay skips. Run on a throw-away test module through pytest itself, with the repo's hook."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

TESTS = Path(__file__).resolve().parent

DEMO = '''
import pytest

@pytest.fixture
def emulator():
    pytest.skip("needs the Firestore emulator (FIRESTORE_EMULATOR_HOST)")

@pytest.mark.skipif(True, reason="ffmpeg/ffprobe not installed")
def test_decodes_audio():
    pass

def test_reads_firestore(emulator):
    pass

@pytest.mark.skipif(True, reason="optional extra 'vocals' is not installed")
def test_separates_vocals():
    pass

def test_plain():
    pass
'''


def run_demo(tmp_path: Path, strict: bool) -> tuple[int, str]:
    (tmp_path / "conftest.py").write_text("from strict_skips import pytest_runtest_makereport  # noqa: F401\n")
    (tmp_path / "test_demo.py").write_text(DEMO)
    env = {k: v for k, v in os.environ.items() if k != "CHORDS_FAIL_ON_SKIP"}
    env["PYTHONPATH"] = str(TESTS)
    if strict:
        env["CHORDS_FAIL_ON_SKIP"] = "1"
    res = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "--rootdir", str(tmp_path),
                          str(tmp_path)], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=120)
    return res.returncode, res.stdout + res.stderr


def test_with_the_flag_an_ffmpeg_or_emulator_skip_fails_the_run(tmp_path: Path) -> None:
    code, out = run_demo(tmp_path, strict=True)
    assert code != 0, out
    assert "1 passed, 1 skipped, 2 errors" in out, out                 # skipped at setup: reported as errors
    assert "must not be skipped" in out and "ffmpeg/ffprobe not installed" in out and "FIRESTORE_EMULATOR_HOST" in out


def test_without_the_flag_they_are_plain_skips(tmp_path: Path) -> None:
    code, out = run_demo(tmp_path, strict=False)
    assert code == 0, out
    assert "1 passed, 3 skipped" in out, out


def test_the_repo_conftest_installs_the_hook() -> None:
    import conftest
    import strict_skips

    assert conftest.pytest_runtest_makereport is strict_skips.pytest_runtest_makereport
