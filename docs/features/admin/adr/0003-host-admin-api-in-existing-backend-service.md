---
status: Accepted
owner: "Тарас Щадило (Tech Lead)"
reviewers: ["Tech Lead", "Security Lead"]
updated_at: "2026-10-07"
feature_size: "L"
ticket: "docs/features/admin/spec.md"
---

# 0003 — Host the admin API as a router inside the existing FastAPI service

- **Status:** Accepted
- **Date:** 2026-10-07
- **Deciders:** Тарас Щадило (Tech Lead) + Claude під час Socratic-проходу `design`

## Context

Сервер — один інстанс (max-instances=1); денні лічильники квоти лежать у `users/<uid>/quota.json` і захищені потоковим замком у процесі (`backend/app/quotas.py`); задачі, що виконуються, живуть лише в пам'яті (`backend/app/jobs.py`). AC-12b вимагає, щоб скидання квоти, що збіглося з прийомом аналізу, нічого не губило; AC-01 показує задачі, що виконуються зараз.

## Decision drivers

- AC-12b — скидання й прийом аналізу не губляться при збігу.
- AC-01 — «задачі, що виконуються зараз».
- NFR «Latency p95 огляд адмінки (сервер спав) ≤ 15 с» — spec приймає холодний старт існуючого сервера.
- §2 — один розробник, один серверний деплой.

## Considered options

1. **Роутер `/api/admin/*` в існуючому FastAPI-сервісі** — новий модуль `backend/app/admin/`, той самий процес, ті самі `Quotas` і `JobManager`.
2. **Окремий легкий Cloud Run admin-сервіс** — ~512 МБ без моделей; лічильники квоти переносяться у Firestore-транзакції, задачі дзеркаляться в базу.

## Decision outcome

**Chosen:** Option 1. Скидання квоти йде через той самий об'єкт `Quotas` під тим самим замком, що й `consume()`, тож AC-12b виконується без нової інфраструктури; задачі, що виконуються, читаються з пам'яті `JobManager`.

## Consequences

**Positive**
- Немає міграції лічильників квоти; немає другого деплою.
- Адмінські ендпоінти перевикористовують middleware автентифікації, формат помилок і клієнт Firestore.

**Negative**
- Відкриття адмінки будить великий інстанс на ~15 хв (KPI «≤ 2% додаткових годин» треба міряти).
- Коректність AC-12b тримається на max-instances=1: підняття понад 1 вимагає перенесення лічильників у Firestore-транзакції (ризик у §11).

**Neutral**
- Винести адмінку в окремий сервіс пізніше можна разом із перенесенням квот у Firestore.

## Links

- Spec: [[../spec.md]]
- SAD: [[../sad.md]] §4, §5
- Related ADR: [[0001-build-admin-as-backend-service-and-web-frontend]]
