---
status: Accepted
owner: "Тарас Щадило (Tech Lead)"
reviewers: ["Tech Lead", "Security Lead"]
updated_at: "2026-10-07"
feature_size: "L"
ticket: "docs/features/admin/spec.md"
---

# 0001 — Build the admin as a backend-service plus a web-frontend, background work inside the backend

- **Status:** Accepted
- **Date:** 2026-10-07
- **Deciders:** Тарас Щадило (Tech Lead) + Claude під час Socratic-проходу `design`

## Context

Адмінка потребує серверного API (spec §6.1: дані адмінки лише через сервер), веб-екранів і фонових робіт: остаточне видалення після 7-денного вікна, закриття денної статистики, очищення історії задач. Сервер спить (scale-to-zero, max 1 instance), тож фонові роботи хтось має будити.

## Decision drivers

- Spec §6.1 — адмінка отримує дані тільки через сервер.
- NFR «Повнота видалення» — 100% за 24 год після кінця вікна, навіть коли сервером ніхто не користується.
- AC-22 — жодна задача, що завершилася пізніше, не повертає пісні видаленого користувача: видалення має бачити ті самі замки, що й задачі.
- §2 — один розробник, один деплой-артефакт сервера.

## Considered options

1. **backend-service + web-frontend** — адмінський API і внутрішні фонові ендпоінти в існуючому FastAPI-сервісі; Cloud Scheduler будить їх; екрани — у збірці сайту.
2. **backend-service + web-frontend + worker** — фонові роботи — окремий Cloud Run Job (як існуючий backfill), без доступу до замків сервера.

## Decision outcome

**Chosen:** Option 1. Фонові роботи бачать in-process замки й об'єкти (`Quotas`, `JobManager`, publish-lock), тож AC-22 виконується без міжпроцесного блокування; лишається один серверний деплой.

## Consequences

**Positive**
- Один серверний артефакт; фонові роботи перевикористовують код сховища й замки.
- `target_surfaces: [backend-service, web-frontend]` — downstream вмикає `ui`-шар задач і фронтові рівні тестів.

**Negative**
- Кожен виклик Cloud Scheduler будить великий інстанс (4 vCPU / 16 GiB) на ~15 хв — входить у KPI «≤ 2% додаткових годин».
- Довгі фонові роботи конкурують із задачами користувачів за CPU.

**Neutral**
- Винести фонові роботи в Cloud Run Job пізніше можна, але знадобиться міжпроцесне блокування через Firestore.

## Links

- Spec: [[../spec.md]]
- SAD: [[../sad.md]] §4, §5, §7
