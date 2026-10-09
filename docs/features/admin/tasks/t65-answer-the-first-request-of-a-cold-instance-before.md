---
id: T65
title: "Answer the first request of a cold instance before the start-up background work begins"
layer: "app"
deps: ["T24"]
acs: ["AC-02", "AC-22"]
files_hint: ["backend/app/main.py", "backend/tests/test_background_start.py", "backend/tests/test_cloud.py", "docs/CLOUD.md"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 11 — production follow-ups"
status: "done"
---

# T65 — Answer the first request of a cold instance before the start-up background work begins

**Blocked by:** T24 · **ACs:** AC-02, AC-22 · NFR «огляд адмінки, сервер спав — p95 ≤ 15 с» (spec §7, §8; test-plan Known gaps) · source: production cold starts, 2026-10-09

## Definition of Done

**Production evidence (chords-api-00012, 5 confirmed cold starts of `GET /api/health`, seconds from the request): GCSFuse mounted 3.6 / 3.2 / 3.5 / 2.7 / 2.6, `Application startup complete` 9.40 / 9.26 / 11.09 / 7.76 / 5.72, response sent 13.18 / 12.29 / 16.08 / 11.15 / 7.97 — 3.8 / 3.0 / 5.0 / 3.4 / 2.25 s after the server was ready (p95 16.35 s over the 15 s bound). At `Application startup complete` the lifespan started `chords-preload` (the `app.engine.neural` import alone 4–6 s on the cold image, then a warm analysis of ~10 s CPU), `chords-upload-sweep`, `chords-publish-sweep` and `chords-wake-sweep`, all competing with the first request for the GIL, the CPU and the cold disk. Here: the four are started by one idempotent `BackgroundStart.start()` (once per app), triggered by a pure-ASGI `AfterFirstResponseMiddleware` (cloud mode only, outermost) once the first response other than a CORS preflight has been sent in full, then a pass-through; with no request, a timer starts it `BACKGROUND_START_QUIET_S` (10 s) after start-up; shutdown before then starts nothing; local mode starts nothing. Which work runs, its order, the wake-sweep slot logic and `stop_background` are unchanged. Tests (`backend/tests/test_background_start.py`) show nothing starts at start-up, exactly once after the first response, not on a preflight, after the quiet period, nothing after an early shutdown, nothing in local mode, and that the trigger fires only after the last body part was sent; the start-up sweep tests in `test_cloud.py` make a request first. docs/CLOUD.md describes the new start. The NFR stays open until re-measured in the cloud.**

- [x] lint clean (ruff)
