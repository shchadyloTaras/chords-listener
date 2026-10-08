"""T44 / review S1-8: migration 04 seeds a banner that satisfies the contract (uk/en 1-250 chars), validated.

Runs with --dry-run, so no emulator or network is needed (the printed document is what would be created).
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

from app.admin.models import BannerIn

MIGRATIONS = Path(__file__).resolve().parents[3] / "docs" / "features" / "admin" / "migrations"


def test_dry_run_seeds_a_valid_disabled_banner_in_the_public_mirror(monkeypatch, capsys):
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", "localhost:1")          # never called under --dry-run
    monkeypatch.setenv("CHORDS_FIREBASE_PROJECT", "t44")
    monkeypatch.setattr(sys, "argv", ["04_seed_runtime_config.up.py", "--dry-run"])
    monkeypatch.syspath_prepend(str(MIGRATIONS))
    import importlib.util
    spec = importlib.util.spec_from_file_location("mig04_t44", MIGRATIONS / "04_seed_runtime_config.up.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.main() == 0
    line = next(l for l in capsys.readouterr().out.splitlines() if "publicStatus/current" in l)
    banner = ast.literal_eval(re.search(r"'banner': (\{[^}]*\})", line).group(1))
    assert banner["enabled"] is False
    BannerIn.model_validate(banner)                                         # uk/en non-empty, <= 250 chars
