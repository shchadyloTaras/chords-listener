---
status: Accepted
owner: "Тарас Щадило (Tech Lead)"
reviewers: ["Tech Lead", "Security Lead"]
updated_at: "2026-10-07"
feature_size: "L"
ticket: "docs/features/admin/spec.md"
---

# 0008 — Gate every cloud job through one admission check before the quota is consumed

- **Status:** Accepted
- **Date:** 2026-10-07
- **Deciders:** Тарас Щадило (Tech Lead) + Claude під час Socratic-проходу `design`

## Context

Хмарні задачі приходять через п'ять входів: посилання (`url`), файл (`upload`), запис вкладки через бакет (`storage`), повторний аналіз (`reanalyze`), транскрипція вокалу (`vocals`). Адмінка додає чотири умови відмови — хмарне обмеження (зокрема заплановане видалення), пауза нових аналізів, вимкнене завантаження з YouTube, вимкнена транскрипція вокалу — і персональний ліміт, що має пріоритет над типовим.

## Decision drivers

- Інваріант CONTEXT: відхилена спроба ніколи не зараховується в денну квоту; жоден перемикач не зупиняє прийняті задачі.
- Інваріант CONTEXT: чинний персональний ліміт має пріоритет над типовим до кінця дати завершення включно (AC-13, AC-13b, AC-15).
- AC-16, AC-18, AC-26, AC-27, AC-28 — відмова для кожного входу; NFR — набуття чинності ≤ 60 с.

## Considered options

1. **Єдиний шлюз допуску** — `backend/app/admission.py`, який `JobManager` викликає в одному місці прийому задачі до `Quotas.consume`; стан користувача — з його проєкції з кешем ≤ 60 с.
2. **Перевірки в кожному обробнику** — кожен із п'яти ендпоінтів сам викликає потрібні перевірки.

## Decision outcome

**Chosen:** Option 1. Порядок фіксований: обмеження/видалення → перемикачі (за видом задачі й джерелом) → чинний ліміт → `consume`; відмова повертає новий код помилки й нічого не рахує.

## Consequences

**Positive**
- Новий вхід задач не може оминути перевірку.
- Одне місце для тестів відмов і пріоритету лімітів.
- Квота під тим самим замком, що й скидання (ADR-0003).

**Negative**
- +1 читання Firestore на задачу при промаху кешу.
- Нові значення `ErrorCode` (обмежено / пауза / вимкнено) мають дзеркалитися у `frontend/src/types.ts` і отримати тексти uk/en.

**Neutral**
- Файл, завантажений у Storage для входу `storage`, може лишитися після відмови — його прибирає існуючий шлях очищення завантажень.

## Links

- Spec: [[../spec.md]]
- SAD: [[../sad.md]] §5, §6
- Related ADR: [[0003-host-admin-api-in-existing-backend-service]]
- Related ADR: [[0005-store-runtime-config-in-firestore-with-public-status-mirror]]
