"""The admin runbook in docs/CLOUD.md (docs/features/admin T39, AC-32).

Docs have no behaviour to run, so this pins what the Definition of Done asks of them: the section exists and
names the grant / revoke commands, the migration order 01-06, the two sweep slots and the two alerts; every file
and link it points at exists; every command it prints names a script or a flag that really exists; the README
links to the admin page; and the spec §8 questions resolved at design are ticked.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
CLOUD = ROOT / "docs" / "CLOUD.md"
README = ROOT / "README.md"
SPEC = ROOT / "docs" / "features" / "admin" / "spec.md"
MIGRATIONS = ROOT / "docs" / "features" / "admin" / "migrations"
HEADING = "## Admin console"


@pytest.fixture(scope="module")
def section() -> str:
    text = CLOUD.read_text(encoding="utf-8")
    assert HEADING in text, f"docs/CLOUD.md has no '{HEADING}' section"
    body = text.split(HEADING, 1)[1]
    return HEADING + re.split(r"\n## ", body, maxsplit=1)[0]


def test_section_describes_granting_and_revoking_admins(section):
    assert "scripts/admin_grant.py grant" in section
    assert "scripts/admin_grant.py revoke" in section
    assert "gcloud auth application-default login" in section
    assert "60" in section  # a revoke takes effect within a minute (AC-32)


def test_section_lists_the_migrations_in_promotion_order(section):
    names = sorted(p.name for p in MIGRATIONS.glob("0?_*.up.*"))
    assert len(names) == 6
    positions = []
    for name in names:
        assert name in section, f"{name} is not in the runbook"
        positions.append(section.index(name))
    assert positions == sorted(positions), "migrations 01-06 must be listed in order"
    assert "--before" in section  # migration 06 takes the launch day


def test_section_names_the_sweep_schedule_and_the_two_alerts(section):
    assert "00:15" in section and "12:15" in section
    assert "chords-sweep-0015" in section and "chords-sweep-1215" in section
    assert "deletion_overdue" in section and "stats_mismatch" in section
    assert "MAX_INSTANCES" in section or "max-instances" in section


def test_paths_and_links_in_the_section_resolve(section):
    for target in re.findall(r"\]\(([^)#\s]+)(?:#[^)]*)?\)", section):
        if target.startswith(("http://", "https://", "mailto:")):
            continue
        assert (CLOUD.parent / target).exists(), f"broken link: {target}"
    for path in re.findall(r"`((?:scripts|docs|backend|frontend)/[\w./-]+)`", section):
        assert (ROOT / path.rstrip("/")).exists(), f"missing path: {path}"


def test_commands_use_flags_the_scripts_define(section):
    grant = (ROOT / "scripts" / "admin_grant.py").read_text(encoding="utf-8")
    for flag in ("--note", "--project"):
        if flag in section:
            assert f'"{flag}"' in grant
    deploy = (ROOT / "scripts" / "deploy_cloud.sh").read_text(encoding="utf-8")
    assert "DRY_RUN" in deploy and "DRY_RUN=1 scripts/deploy_cloud.sh" in section
    for flag in set(re.findall(r"(--dry-run)", section)):
        for up in MIGRATIONS.glob("0[456]_*.up.py"):
            assert flag in up.read_text(encoding="utf-8")


def test_readme_links_to_the_admin_page_and_the_runbook():
    readme = README.read_text(encoding="utf-8")
    assert "chords-listener/admin.html" in readme
    assert "docs/CLOUD.md#admin-console" in readme


def test_spec_open_questions_resolved_at_design_are_ticked():
    spec = SPEC.read_text(encoding="utf-8")
    open_questions = spec.split("## 8. Open questions", 1)[1]
    assert "- [ ]" not in open_questions.split("\n## ", 1)[0], "an open question is still unticked"
    assert open_questions.count("- [x]") >= 4
