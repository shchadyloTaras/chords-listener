---
status: Draft
owner: "Тарас Щадило (Tech Lead)"
reviewers: ["Tech Lead", "Security Lead"]
updated_at: "2026-10-07"
feature_size: "L"
target_surfaces: [backend-service, web-frontend]  # decided in §4 (ADR-0001) — subset of: backend-service | web-frontend | mobile-app | desktop-app | cli | worker | library-sdk. Read (never re-derived) by api/sequences/tasks/plan-tests/review → _shared/surfaces.md
---

# Software Architecture Document — admin

<!-- 12 Arc42 sections. Empty section → <!-- N/A: <one-line reason> -->. -->
<!-- C4 Context (L1) lives inline in §3. C4 Container (L2) lives inline in §5. -->
<!-- Numbers in §10 come VERBATIM from spec.md §6 NFR — no inventing, no rounding. -->

## 1. Introduction and goals

<!-- 🎯 Why: durable memory of «what + the three dominant qualities + who cares». A year from
     now nobody recalls which three qualities were critical for this system.
     📋 Write: 1 ¶ intent + 3 lines of top-3 quality goals + a stakeholders table.
     ¶4 is the override slot — critic `Override` resolutions emit «Decision override: <headline>
     — rationale: <reason>» bullets here so downstream skills see the deliberate choice. -->

**Intent.** Власна адмінка всередині Chords Listener для Адміністратора: перегляд стану хмари (огляд доби, користувачі акаунтів і їхні картки, історія задач і причини збою, денна статистика, журнал дій адміністратора), дії з користувачами акаунтів (скидання денної квоти, персональний ліміт, хмарне обмеження, заплановане видалення) і налаштування сервісу (типові ліміти, перемикачі сервісу, банер обслуговування) без повторного розгортання сервера. Мета — витрати під контролем, швидка підтримка, розуміння продукту й готовність до тарифів (spec §2). Постачається трьома етапами: (1) перегляд, (2) дії з користувачами, (3) налаштування сервісу.

**Top-3 quality goals (1-liners; full scenarios in §10):**

1. **Безпека межі адміністратора** — права перевіряє сервер на кожен адмінський запит; без запису в журнал дій адміністратора ні дія, ні перегляд особистих даних не відбувається; текст від користувачів завжди лише текст.
2. **Вартість і сон сервера** — ≤ 200 читань сховища на екран адмінки; відкрита вкладка без дій створює 0 запитів до сервера; банер і стан перемикачів на сайті — 0 запитів до хмарного сервера.
3. **Керованість без розгортання** — зміни, які застосовує сервер, набувають чинності ≤ 60 с; банер і стан перемикачів на сайті для нових відвідувань — ≤ 5 хв.

Інші NFR (повнота видалення, точність денної статистики, зберігання журналу й історії задач, latency, availability) мають власні сценарії в §10.

**Stakeholders.**

| Role | Interest | Sign-off owner? |
|---|---|---|
| Адміністратор | Користується адмінкою: підтримка, контроль витрат, налаштування | No |
| Користувач акаунта | На ньому діють персональний ліміт, хмарне обмеження, заплановане видалення; приватність email і списку пісень | No |
| Гість | Бачить банер обслуговування; стан перемикачів впливає на сайт | No |
| Security Lead | Обов'язковий security review (spec §6.1): нова межа доступу, особисті дані в одному місці, незворотне видалення | Yes |
| Tech Lead | SAD approval | Yes |

<!-- Decision overrides (¶4) — populated by the critic resolution loop, empty otherwise. -->

## 2. Constraints

<!-- 🎯 Why: §4 strategy only works when §2 has fixed WHAT IS ALREADY FIXED — stack, versions,
     deadline, regulatory. This is an input, not an output.
     📋 Write: four blocks — Technical / Organisational / Conventions / Regulatory.
     📌 Pin versions («<datastore> 18», not «<datastore>»); «Q3 deadline — hard», not «ideally».
     Never N/A — every feature inherits at least Conventions + Technical. -->

**Technical.**
- Frontend: React 19.2 + TypeScript 6.0, Vite 8.3, Tailwind CSS 4.3, zustand 5, Firebase JS SDK 12.19; власний hash-роутинг (`frontend/src/hooks/useRoute.ts`); i18n — `frontend/src/i18n/{uk,en}.ts` без бібліотеки.
- Хостинг сайту: **GitHub Pages** (`.github/workflows/pages.yml`, base `/chords-listener/`) — статичний, HTTP-заголовки задати не можна, тому політика безпеки сторінки (CSP) можлива лише через `<meta http-equiv>`.
- Backend: Python 3.11 (uv) + FastAPI на **Cloud Run** europe-west1, gen2, 4 vCPU / 16 GiB, CPU always allocated, concurrency 16, **min 0 / max 1 instance**, засинає після ~15 хв без запитів, холодний старт ~9 с (`docs/CLOUD.md`, `scripts/deploy_cloud.sh`). YouTube із сервера працює лише через Direct VPC egress + Cloud NAT.
- Дані: Firestore (eur3, без кастомних індексів) через REST-клієнт сервісного акаунта (`backend/app/firestore.py`, без gRPC/Admin SDK); GCS-бакет, змонтований у `/data` (GCSFuse).
- Денні лічильники квоти — файл `users/<uid>/quota.json` під потоковим замком у процесі (`backend/app/quotas.py`) — коректно лише завдяки max 1 instance. Задачі — лише в пам'яті (`backend/app/jobs.py`), зникають при рестарті.
- Auth: Firebase Auth (email + пароль); сервер сам перевіряє ID-токен RS256 (`backend/app/auth.py`); кастомних claims і ролей немає.
- Налаштування сервера — лише env-змінні (`CHORDS_QUOTA_*`, `CHORDS_PUBLISH`…): сьогодні зміна лімітів = повторне розгортання.
- Архітектурна конвенція backend: API-шар (`main.py`) → бізнес (`jobs`, `storage`, `quotas`, `publish`) → інфраструктура (`auth`, `sources`, `firestore`, `gcs`).

**Organisational.**
- Один розробник-власник (він же Адміністратор).
- Постачання трьома етапами (spec §1): перегляд → дії з користувачами → налаштування сервісу.
- Дедлайн і бюджет зусиль: `<TBD by PM>` — див. §11.

**Conventions.**
- Відповідь з помилкою `{"detail": str, "code": ErrorCode}`, HTTP-статус з `STATUS_BY_CODE` (`backend/app/main.py`); коди — enum `ErrorCode` (`backend/app/models.py`).
- Логування — модуль `logging`, логери `chords.*`, stdout → Cloud Logging.
- Типи API — `frontend/src/types.ts` дзеркалить Pydantic-моделі `backend/app/models.py`.
- Тести: pytest (`backend/tests`, емулятори Firebase Auth/Storage/Firestore), vitest (`frontend/src/**/*.test.ts`); CI — GitHub Actions (lint + test + build).
- Правила доступу клієнтів — `firestore.rules`, `storage.rules`: «лише власник», сервісний акаунт їх обходить.

**Regulatory / external.**
- Особисті дані користувачів (зокрема з ЄС): запит на видалення виконується остаточно протягом 24 год після кінця 7-денного вікна; в журналі й історії задач лишаються лише знеособлені записи (spec §6, §6.1).
- Журнал дій адміністратора зберігається ≥ 365 днів і незмінний; історія задач — ≥ 90 днів.
- Security review обов'язковий (spec §6.1).

## 3. Context and scope

<!-- 🎯 Why: draws the SYSTEM BOUNDARY — who talks to it from outside, where the trust zone ends.
     Without §3, §5 and §8 (authorization) blur — unclear what's «inside» vs «outside».
     📋 Write: 2–3 sentences of business context + an external-systems table + a C4Context block.
     📌 «External: none (deliberate, no third-party in v1)» is itself a decision worth stating.
     Trust boundary — the line past which you don't trust data without checking it.
     Never N/A — greenfield still draws the planned actors + external systems. -->

Chords Listener розпізнає акорди пісень у браузері (Гість) і на хмарному сервері (Користувач акаунта: серверний аналіз, хмарна бібліотека, денна квота). Адмінка додає третю роль — Адміністратора, який бачить і керує хмарною частиною: переглядає користувачів акаунтів, історію задач і денну статистику, змінює квоти, ліміти, хмарні обмеження, видалення та налаштування сервісу. Межа довіри (лінія, за якою дані не довіряють без перевірки) проходить по серверу: браузер — включно з кодом адмінки, який публічний на GitHub Pages — ненадійний, кожну адмінську дію й читання перевіряє сервер.

<!-- brownfield: React 19 SPA на GitHub Pages + FastAPI на Cloud Run (max 1 instance, scale-to-zero) + Firestore/GCS + Firebase Auth; кастомних claims, ролей і runtime-налаштувань ще немає; задачі лише в пам'яті. -->

**External systems (in / out):**

| Actor or system | Type | Interaction |
|---|---|---|
| Адміністратор | Person | Відкриває адмінку, шукає користувачів, виконує дії, змінює налаштування сервісу |
| Користувач акаунта | Person | Запускає хмарні аналізи й транскрипції; бачить пояснення хмарного обмеження / паузи; бачить банер |
| Гість | Person | Користується сайтом без акаунта; бачить банер обслуговування й стан перемикачів |
| Скрипт власника | Tool (out-of-band) | Видає й знімає позначку адміністратора; єдиний шлях видачі прав (spec §3) |
| Firebase Authentication | System (external, Google) | Вхід email+пароль, ID-токени (зокрема час входу для повторної перевірки пароля), облікові записи; остаточне видалення акаунта |
| Cloud Scheduler | System (external, Google) | Періодично будить сервер для остаточних видалень, закриття денної статистики й інших фонових робіт — бо сервер спить і сам не прокидається |
| GitHub Pages | System (external) | Віддає статичний код сайту й адмінки; без даних і секретів |
| YouTube | System (external) | Джерело завантажень (існуюче); перемикач сервісу вимикає серверні завантаження |

Сповіщень користувачам (листів) і алертів в адмінці — свідомо **немає** у v1 (spec §3 Non-goals, §8 OQ про листи). Єдиний виняток — два операційні алерти Cloud Monitoring власнику за NFR (прострочене видалення, розбіжність статистики) у консолі хмари, як бюджетні сповіщення (§7).

**C4 Context (L1):**

```mermaid
C4Context
    title admin — System Context

    Person(admin, "Адміністратор", "керує хмарою через адмінку")
    Person(user, "Користувач акаунта", "хмарні аналізи, бібліотека, денна квота")
    Person(guest, "Гість", "розпізнавання лише в браузері")
    Person_Ext(owner, "Скрипт власника", "видає і знімає позначку адміністратора")

    System(cl, "Chords Listener", "сайт + хмарний сервер + адмінка; дані у Firestore і GCS")
    System_Ext(fbauth, "Firebase Authentication", "вхід, ID-токени, облікові записи")
    System_Ext(sched, "Cloud Scheduler", "періодично будить сервер для фонових робіт")
    System_Ext(pages, "GitHub Pages", "статичний код сайту й адмінки")
    System_Ext(yt, "YouTube", "джерело завантажень")

    Rel(admin, cl, "переглядає й змінює стан хмари", "HTTPS")
    Rel(user, cl, "аналізи, бібліотека", "HTTPS")
    Rel(guest, cl, "бачить банер і стан перемикачів", "HTTPS")
    Rel(owner, cl, "записує позначку адміністратора", "ADC власника")
    Rel(cl, fbauth, "перевіряє токени, видаляє акаунти", "HTTPS")
    Rel(sched, cl, "будить для видалень і статистики", "HTTPS + OIDC")
    Rel(pages, cl, "віддає код сайту", "HTTPS")
    Rel(cl, yt, "завантажує аудіо", "HTTPS")
```

## 4. Solution strategy

<!-- 🎯 Why: the 3–4 STRATEGIC PILLARS every ADR grows from. Without §4 each ADR looks random —
     there's no umbrella. ⭐ The densest section — the blast-radius gate fires almost always here
     (decisions are irreversible + multi-module).
     📋 Write: 3–4 choices; each a heading + 2–3 sentences of rationale.
     📌 «Store content as a table of typed blocks» is a pillar — ADR-0001 grows from it. -->

**Top strategic choices (the seeds for ADRs):**

1. **Дві поверхні: `backend-service` + `web-frontend`; фонові роботи — всередині сервера** ([ADR-0001](adr/0001-build-admin-as-backend-service-and-web-frontend.md)). Адмінський API й внутрішні фонові ендпоінти (остаточне видалення, звірка й закриття денної статистики, закриття «завислих» задач, синхронізація індексу email; строки зберігання — TTL-політики Firestore, не фонова робота) живуть в існуючому FastAPI-сервісі, а Cloud Scheduler будить їх. Так фонові роботи бачать ті самі замки, що й задачі (AC-22), і лишається один серверний деплой (§2).
2. **Адмінка — окрема точка входу `admin.html` із суворою CSP** ([ADR-0002](adr/0002-ship-admin-ui-as-separate-strict-csp-entry.md)). Та сама Vite-збірка й ті самі компоненти, Tailwind-токени, i18n і вхід Firebase, але без TF.js і плеєра та з `<meta>`-CSP, що забороняє inline-скрипти й eval. Друга лінія захисту від stored XSS (ціль якості №1) без ризику для основного сайту.
3. **Адмінський API — роутер `/api/admin/*` в існуючому сервері** ([ADR-0003](adr/0003-host-admin-api-in-existing-backend-service.md)). Скидання квоти проходить через той самий об'єкт `Quotas` і той самий замок, що й прийом аналізу (AC-12b), а задачі, що виконуються зараз, читаються з пам'яті `JobManager` (AC-01). Ціна — залежність від max-instances=1 (§11).
4. **Модель читання — заздалегідь пораховані проєкції у Firestore** ([ADR-0004](adr/0004-precompute-admin-read-model-in-firestore.md)). Сервер у момент подій пише довідник користувачів, запис кожної задачі, атомарні інкременти денної статистики й журнал у закриті для клієнтів колекції; кожен екран — кілька десятків читань (ціль якості №2: ≤ 200 читань на екран). Строки зберігання — TTL-політики Firestore.
5. **Налаштування сервісу — Firestore + публічне дзеркало** ([ADR-0005](adr/0005-store-runtime-config-in-firestore-with-public-status-mirror.md)). Закритий документ налаштувань сервер кешує лінивим TTL 30 с (≤ 60 с на набуття чинності, без фонового опитування); публічний документ із банером і станом перемикачів сайт читає напряму з Firestore (0 запитів до сервера, ≤ 5 хв). Env-змінні лишаються лише початковими значеннями.
6. **Права адміністратора — allowlist у Firestore з кешем 60 с** ([ADR-0006](adr/0006-authorize-admins-via-firestore-allowlist-with-60s-cache.md)). Список пише лише скрипт власника; сервер перевіряє його на кожен адмінський запит і відповідає не-адміністраторам так само, як на неіснуючу адресу. Повторний вхід для остаточних дій — за `auth_time` ID-токена (≤ 15 хв).
7. **«Без журналу — без дії»: атомарно, де можна, інакше журнал перший** ([ADR-0007](adr/0007-write-audit-atomically-or-before-the-effect.md)). Зміни у Firestore і запис журналу — один batched write; для ефектів поза Firestore (скидання `quota.json`) — спершу журнал, потім дія, при невдачі — запис «не застосовано»; перегляди — журнал перед відповіддю.

**UI-architecture (web-frontend):** окремий multi-page entry `admin.html` (client-side SPA, React 19) з власним hash-роутингом за зразком `frontend/src/hooks/useRoute.ts`; стан — локальний для екранів (React state + невеликий zustand-стор для сесії адміністратора), бо екрани незалежні й дані завжди свіжі з сервера; перевикористовує компоненти, Tailwind-токени, `i18n/{uk,en}.ts` і `lib/auth` основного сайту → ADR-0002.

Each tactical decision in later sections should trace to one of these seeds. Tactical decisions that *contradict* a strategic choice are red flags — surface them in §11.

## 5. Building block view

<!-- 🎯 Why: INTERNAL DECOMPOSITION — modules, containers, datastores. The static topology: who
     may talk to whom. Without §5, §6 (the flows) has no vocabulary of participants.
     📋 Write: 1 ¶ on the style (layered / hexagonal / clean / event-driven) + a folder tree + a
     C4Container block.
     📌 Draw ONE Container per declared `target_surface` (frontmatter): a fullstack
     [backend-service, web-frontend] = a backend-API container + a web/SPA container; a
     [backend-service, mobile-app] = the API + the mobile app. The Container(web, …) line below is
     just one surface's container — swap/add per what was declared in §4. → _shared/surfaces.md
     📌 e.g. «web app, content API, media worker, datastore, object store, CDN». -->

Шарова архітектура репозиторію зберігається (§2): API-шар (FastAPI-роутери) → бізнес-модулі → інфраструктура (`firestore`, `gcs`, `auth`). Адмінка — новий пакет `backend/app/admin/` зі своїм роутером, що монтується в `main.py`; зміни існуючих модулів зведені до двох точок інтеграції: **шлюз допуску** (admission gate) перед `Quotas.consume` для кожної хмарної задачі і **хуки проєкцій** у `JobManager` (запис історії задач і денної статистики в момент подій). На фронтенді адмінка — окрема точка входу `admin.html` (ADR-0002), а основний сайт отримує лише читача публічного стану сервісу (банер + перемикачі).

**Building-block decisions:**
- **Єдиний шлюз допуску** ([ADR-0008](adr/0008-gate-every-cloud-job-through-one-admission-check.md)) — усі п'ять входів хмарних задач проходять `admission.py` до `Quotas.consume`: обмеження/видалення → перемикачі → чинний ліміт → consume; відмова нічого не рахує.
- **Пошук email у пам'яті над компактним індексом** ([ADR-0009](adr/0009-search-emails-in-memory-over-a-compact-firestore-index.md)) — шарди uid → email у Firestore, підрядок шукається на сервері; нові реєстрації дотягуються з `users` перед пошуком.
- **Денна статистика: живі лічильники + нічна звірка й заморожування** ([ADR-0010](adr/0010-count-daily-stats-live-and-freeze-after-nightly-reconciliation.md)).
- **Історія задач** пишеться з `JobManager` при прийомі й при завершенні задачі (ADR-0004); задача, що «зависла» через рестарт інстансу, закривається фоновою роботою (двічі на добу, §7) з причиною збою «Інше». `ErrorCode` відображається на фіксований список причин збою з підписами uk/en.

**Internal decomposition:**

```
backend/app/
├── admission.py        шлюз допуску: хмарне обмеження / заплановане видалення, перемикачі сервісу,
│                       чинний ліміт (персональний > типовий) — до Quotas.consume; відмова не рахується в квоту
├── admin/
│   ├── router.py       /api/admin/* (APIRouter); не-адміністратору — та сама відповідь, що й на неіснуючу адресу
│   ├── authz.py        allowlist адміністраторів (кеш ≤ 60 с), перевірка auth_time, ліміт спроб не-адміністраторів
│   ├── audit.py        журнал дій адміністратора: batched write зі зміною або «журнал перший» (ADR-0007)
│   ├── directory.py    довідник користувачів (проєкція) + індекс email + пошук підрядка
│   ├── history.py      запис історії задач + відображення ErrorCode → причина збою
│   ├── stats.py        денні лічильники (інкремент у момент події), закриття й звірка дня
│   ├── settings.py     налаштування сервісу (лінивий кеш 30 с) + публічне дзеркало
│   ├── actions.py      скидання квоти, персональний ліміт, хмарне обмеження, заплановане видалення
│   ├── deletion.py     остаточне видалення: стирання даних + знеособлення журналу й історії
│   └── sweeps.py       внутрішні ендпоінти, які будить Cloud Scheduler (OIDC)
├── jobs.py             + виклик admission, + хуки history/stats (існуючий)
├── quotas.py           + чинний ліміт на uid, + reset під тим самим замком (існуючий)
├── auth.py             + віддає auth_time перевіреного токена (існуючий)
└── firestore.py        + batched write, запити, count-агрегації (існуючий)

frontend/
├── admin.html          друга точка входу Vite, сувора CSP у <meta>
└── src/
    ├── admin/          main.tsx, маршрути, екрани: Огляд, Користувачі, Картка, Задачі, Статистика, Журнал, Налаштування
    ├── lib/adminApi.ts клієнт /api/admin/* (перевхід при вимозі свіжого входу)
    ├── lib/serviceStatus.ts  читання публічного стану (банер + перемикачі) для основного сайту
    └── i18n/{uk,en}.ts       + домен admin
scripts/admin_grant.py      скрипт власника: видати / зняти позначку адміністратора
```

**C4 Container (L2):**

```mermaid
C4Container
    title admin — Containers

    Person(admin, "Адміністратор")
    Person(user, "Користувач акаунта")
    Person(guest, "Гість")
    Person_Ext(owner, "Скрипт власника")

    Container_Boundary(cl, "Chords Listener") {
        Container(site, "Сайт", "React 19, Vite, GitHub Pages", "розпізнавання, бібліотека; читає публічний стан сервісу")
        Container(adminui, "Адмінка admin.html", "React 19, Vite, сувора CSP", "екрани адмінки; дані лише через сервер")
        Container(api, "Хмарний сервер", "Python 3.11, FastAPI, Cloud Run", "аналізи, шлюз допуску, /api/admin/*, фонові ендпоінти")
        ContainerDb(fs, "Firestore", "Firestore eur3", "бібліотека; адмінські проєкції, журнал, налаштування, публічний стан")
        ContainerDb(gcs, "Бакет", "Cloud Storage", "аудіо й треки, quota.json")
    }

    System_Ext(fbauth, "Firebase Authentication", "вхід, ID-токени, облікові записи")
    System_Ext(sched, "Cloud Scheduler", "будить фонові роботи двічі на добу")
    System_Ext(yt, "YouTube", "джерело завантажень")

    Rel(admin, adminui, "переглядає й змінює", "HTTPS")
    Rel(user, site, "аналізи, бібліотека", "HTTPS")
    Rel(guest, site, "розпізнає в браузері", "HTTPS")
    Rel(adminui, api, "адмінські запити з ID-токеном", "JSON/HTTPS")
    Rel(site, api, "хмарні задачі з ID-токеном", "JSON/HTTPS")
    Rel(site, fs, "читає публічний стан і свою бібліотеку", "Firebase SDK")
    Rel(adminui, fbauth, "вхід і повторний вхід", "Firebase SDK")
    Rel(api, fs, "проєкції, журнал, налаштування", "REST, service account")
    Rel(api, gcs, "треки, квоти, видалення", "GCSFuse")
    Rel(api, fbauth, "перевіряє токени, читає й видаляє акаунти", "HTTPS")
    Rel(api, yt, "завантажує аудіо", "HTTPS")
    Rel(sched, api, "будить фонові роботи", "HTTPS + OIDC")
    Rel(owner, fs, "пише allowlist адміністраторів", "ADC власника")
```

## 6. Runtime view

<!-- 🎯 Why: the RUNTIME FLOW of 1–2 critical scenarios — who talks to whom, when, in what order.
     Without §6, §5 is just boxes with no life.
     📋 Write: a Mermaid sequenceDiagram. Participants are names from §5 (don't invent new ones).
     Messages are semantic («saves a draft»), NO HTTP verbs / paths / status codes — endpoint-level
     sequences arrive at the `api` stage.
     📌 e.g. «author → web: composes draft → web → content API: save». Seed the primary flow(s) here;
     the `sequences` stage then covers every §5 AC (no cap). Never N/A for M+; XS/S keeps ≥1 happy-path flow. -->

Seed-потоки нижче покривають три найризиковіші механізми: «без журналу — без дії» (ADR-0007), шлюз допуску (ADR-0008) і остаточне видалення. Етап `sequences` додає потоки для кожного AC (огляд, пошук і картка з журналом переглядів, скидання квоти, персональний ліміт, налаштування, банер, повторний вхід, ліміт спроб не-адміністраторів). Учасники — контейнери з §5.

**Critical flow 1: дія адміністратора з журналом (хмарне обмеження — AC-16, AC-17, AC-31, AC-33)**

```mermaid
sequenceDiagram
    actor A as Адміністратор
    participant UI as Адмінка admin.html
    participant API as Хмарний сервер
    participant FS as Firestore
    A->>UI: накладає хмарне обмеження з причиною
    UI->>API: адмінська дія з ID-токеном
    API->>API: перевіряє токен і allowlist адміністраторів, кеш до 60 с
    alt не адміністратор
        API-->>UI: та сама відповідь, що й на неіснуючу адресу
    else ціль - власний акаунт адміністратора
        API->>FS: запис журналу - відхилена спроба з причиною
        API-->>UI: відмова з поясненням
    else адміністратор, інший користувач
        API->>FS: один batched write - стан користувача і запис журналу
        alt запис не вдався
            FS-->>API: помилка
            API-->>UI: зміну не застосовано, треба повторити
        else успіх
            FS-->>API: ok
            API-->>UI: новий стан картки
            UI-->>A: картка показує хмарне обмеження, причину і дату
        end
    end
```

**Critical flow 2: прийом хмарної задачі через шлюз допуску (AC-13, AC-18, AC-26, AC-27)**

```mermaid
sequenceDiagram
    actor U as Користувач акаунта
    participant Site as Сайт
    participant FS as Firestore
    participant API as Хмарний сервер
    participant GCS as Бакет
    Site->>FS: читає публічний стан сервісу, якщо він старший за 5 хв
    FS-->>Site: банер і стан перемикачів
    U->>Site: вставляє посилання на YouTube
    alt завантаження з YouTube вимкнено за публічним станом
        Site-->>U: пропонує Слухати у вкладці, сервер не викликається
    else
        Site->>API: хмарна задача з ID-токеном
        API->>FS: стан користувача і налаштування, якщо кеш застарів
        API->>API: шлюз допуску - обмеження, перемикачі, чинний ліміт
        alt відмова
            API-->>Site: код відмови, квота не змінюється
            Site-->>U: пояснення і розпізнавання в браузері
        else допущено
            API->>GCS: зараховує в денну квоту під замком
            API->>FS: запис історії задачі і лічильники дня
            API-->>Site: задачу прийнято
        end
    end
```

**Critical flow 3: остаточне видалення після 7-денного вікна (AC-22)**

Порядок кроків і ідемпотентність → [ADR-0011](adr/0011-purge-accounts-tombstone-first-with-idempotent-steps.md).

```mermaid
sequenceDiagram
    participant Sch as Cloud Scheduler
    participant API as Хмарний сервер
    participant FS as Firestore
    participant GCS as Бакет
    participant Auth as Firebase Authentication
    Sch->>API: виклик фонових робіт двічі на добу з OIDC-токеном
    API->>API: перевіряє OIDC-токен планувальника
    API->>FS: заплановані видалення, у яких вікно минуло
    loop кожен такий користувач, кожен крок ідемпотентний
        API->>FS: надгробок uid - пізні результати задач відкидаються
        API->>GCS: стирає треки, аудіо, правки і квоти
        API->>FS: стирає бібліотеку, users, довідник, ліміти і email з індексу пошуку
        API->>FS: знеособлює записи журналу та історії задач
        API->>Auth: видаляє обліковий запис
        API->>FS: позначає видалення завершеним
    end
    API->>FS: звіряє і заморожує вчорашній день статистики
```

<!-- Flows below added by `sequences`: generic participants only, one flow per user story / runtime path. -->

### Огляд адмінки (US-01: AC-01, AC-02)

```mermaid
sequenceDiagram
    autonumber
    actor A as <user> Адміністратор
    participant UI as <ui> адмінка
    participant S as <service>
    participant D as <data-store>

    Note over A,S: Precondition: адміністратор увійшов, допуск пройдено (Cross-cutting: допуск до адмінського API)
    A->>UI: відкриває огляд
    UI->>S: запитує огляд доби з ID-токеном
    Note over UI,S: якщо сервер спав - холодний старт до 15 с, адмінка показує стан завантаження
    S->>D: читає лічильники поточної доби UTC
    Note over S,D: reads денна статистика за ключем доби UTC - один документ
    D-->>S: аналізи за джерелами, транскрипції вокалу, невдалі задачі, активні й нові користувачі
    S->>S: бере задачі, що виконуються зараз, зі свого стану в пам'яті
    S->>D: читає налаштування сервісу, якщо кеш старший за 30 с
    D-->>S: стан перемикачів сервісу
    S-->>UI: підсумки доби, поточні задачі, стан перемикачів
    UI-->>A: показує огляд
    alt вкладка лишається відкритою без дій
        Note over UI,S: жодних запитів - періодичного оновлення немає, сервер засинає як звичайно
    else адміністратор повертається до вкладки
        alt від останнього оновлення минуло менше хвилини
            UI-->>A: лишає наявні дані без запиту
        else минула хвилина або більше
            UI->>S: запитує огляд доби повторно
            S-->>UI: свіжі підсумки
            UI-->>A: оновлює огляд
        end
    else адміністратор натискає Оновити
        A->>UI: натискає Оновити
        UI->>S: запитує огляд доби повторно
        S-->>UI: свіжі підсумки
        UI-->>A: оновлює огляд
    end
    Note over A,S: Postcondition: огляд актуальний на момент відкриття, відкрита вкладка не тримає сервер
```

### Пошук і картка користувача (US-02, US-03: AC-03, AC-04, AC-05, AC-06, AC-10b, AC-33b)

```mermaid
sequenceDiagram
    autonumber
    actor A as <user> Адміністратор
    participant UI as <ui> адмінка
    participant S as <service>
    participant D as <data-store>

    Note over A,S: Precondition: адміністратор увійшов, допуск пройдено (Cross-cutting: допуск до адмінського API)
    A->>UI: вводить частину email
    alt рядок коротший за 3 символи
        UI-->>A: просить ввести щонайменше 3 символи, запит не надсилається
    else 3 символи або більше
        UI->>S: шукає користувачів за підрядком
        S->>S: повторно перевіряє довжину рядка
        S->>D: дочитує нові реєстрації в індекс email
        Note over S,D: reads користувачі, створені після останньої синхронізації індексу (informs data-model index)
        S->>S: шукає підрядок без урахування регістру в індексі в пам'яті
        S->>D: пише запис журналу - перегляд, пошук з рядком
        Note over S,D: persists запис журналу дій адміністратора (тип пошук, адміністратор, рядок, час)
        alt запис журналу не вдався
            S-->>UI: дані недоступні, треба повторити
            UI-->>A: результати не показуються
        else збігів немає
            S-->>UI: порожній список
            UI-->>A: Нікого не знайдено
        else є збіги
            S-->>UI: список користувачів
            UI-->>A: показує результати
        end
    end
    A->>UI: відкриває картку користувача
    UI->>S: запитує картку
    S->>D: читає довідник користувача, стан, персональний ліміт
    S->>S: бере використання денної квоти сьогодні
    S->>D: читає першу сторінку з 50 пісень від нових до старих - лише метадані
    Note over S,D: reads пісні власника за датою додавання, сторінки по 50 (informs data-model index)
    S->>D: пише запис журналу - перегляд картки над uid
    Note over S,D: persists запис журналу дій адміністратора (тип перегляд картки, адміністратор, uid, час)
    alt запис журналу не вдався
        S-->>UI: дані недоступні, треба повторити
        UI-->>A: картка не показується
    else успіх
        S-->>UI: картка і пісні - назва, джерело, дата, тривалість, статус, причина збою
        UI-->>A: показує картку, усі тексти користувачів як звичайний текст
    end
    opt наступна сторінка пісень
        A->>UI: гортає далі
        UI->>S: запитує 50 пісень після останньої показаної
        S->>D: читає наступну сторінку
        S-->>UI: сторінка пісень
    end
    Note over UI,S: дії відкрити чи прослухати пісню немає - сервер не віддає аудіо, акорди чи правки
    Note over A,S: Postcondition: кожен показ особистих даних має запис у журналі дій
```

### Історія задач (US-04: AC-07)

```mermaid
sequenceDiagram
    autonumber
    actor A as <user> Адміністратор
    participant UI as <ui> адмінка
    participant S as <service>
    participant D as <data-store>

    Note over A,S: Precondition: історія задач пишеться з життєвого циклу задачі (потік Проєкції), зберігається 90 днів
    A->>UI: обирає фільтри - результат невдала, джерело YouTube, останні 7 днів
    UI->>S: запитує історію задач з фільтрами
    S->>D: читає сторінку записів історії за фільтрами, від нових до старих
    Note over S,D: reads історія задач за результат, причина збою, джерело і час (informs data-model composite index)
    S->>D: рахує записи за кожною категорією причини збою з тими самими фільтрами
    D-->>S: сторінка записів і кількості за категоріями
    alt за фільтрами нічого немає
        S-->>UI: порожній список і нульові кількості
        UI-->>A: показує, що задач за фільтрами немає
    else є задачі
        S-->>UI: задачі з користувачем, часом, джерелом, причиною і коротким текстом помилки, кількості за категоріями
        UI-->>A: показує список, причину підписом простими словами, текст помилки як звичайний текст
    end
    Note over A,S: Postcondition: видалені користувачі показані як видалений, без email
```

### Статистика за період (US-05: AC-08, AC-09)

```mermaid
sequenceDiagram
    autonumber
    actor A as <user> Адміністратор
    participant UI as <ui> адмінка
    participant S as <service>
    participant D as <data-store>

    Note over A,S: Precondition: разове відновлення днів до запуску з наявних пісень уже виконане (одноразовий скрипт, не runtime-потік)
    A->>UI: обирає період, наприклад останні 30 днів
    alt період довший за 90 днів або кінець раніше за початок
        UI-->>A: пояснює правило періоду, запит не надсилається
    else період коректний
        UI->>S: запитує статистику за період
        S->>S: повторно перевіряє період
        alt період некоректний
            S-->>UI: відмова з поясненням правила періоду
        else період коректний
            S->>D: читає денні документи статистики за діапазоном ключів доби
            Note over S,D: reads денна статистика за ключем доби UTC, до 90 документів (informs data-model index)
            D-->>S: дні - поточний живий, завершені заморожені, відновлені з пісень
            S-->>UI: статистика за кожен день періоду
            UI-->>A: показує дні, відновлені позначені й містять лише додані пісні за джерелами
        end
    end
    Note over A,S: Postcondition: підсумки завершених днів не змінюються
```

### Журнал дій адміністратора (US-06: AC-10, AC-10b, AC-11)

```mermaid
sequenceDiagram
    autonumber
    actor A as <user> Адміністратор
    participant UI as <ui> адмінка
    participant S as <service>
    participant D as <data-store>

    Note over A,S: Precondition: журнал містить зміни, відхилені спроби змін і перегляди особистих даних, записи зберігаються не менше 365 днів
    A->>UI: відкриває журнал, за потреби фільтрує за адміністратором, користувачем чи типом дії
    UI->>S: запитує сторінку журналу з фільтрами
    S->>D: читає сторінку записів журналу за фільтрами від нових до старих
    Note over S,D: reads журнал за адміністратор, користувач, тип дії і час (informs data-model composite index)
    D-->>S: записи - хто, коли, над ким чи яким налаштуванням, що було, що стало, причина відмови
    S->>D: читає email користувачів із записів у довіднику
    S->>S: для остаточно видалених користувачів ставить позначку видалений без email
    alt за фільтрами записів немає
        S-->>UI: порожня сторінка
        UI-->>A: показує, що записів немає
    else є записи
        S-->>UI: сторінка записів
        UI-->>A: показує дії, відхилені спроби, пошуки й перегляди карток від нових до старих
    end
    Note over UI,S: дій змінити чи видалити запис журналу немає ні в адмінці, ні в API, клієнтам доступ до журналу закрито
    Note over A,S: Postcondition: журнал лише читається, записи незмінні
```

### Скидання денної квоти (US-07: AC-12, AC-12b, AC-33)

```mermaid
sequenceDiagram
    autonumber
    actor A as <user> Адміністратор
    participant UI as <ui> адмінка
    participant S as <service>
    participant D as <data-store>
    participant Q as <data-store> квот

    Note over A,Q: Precondition: користувач сьогодні використав 40 аналізів і 5 транскрипцій вокалу, одна його задача виконується
    A->>UI: натискає Скинути денну квоту
    UI->>S: скидає денну квоту користувача
    S->>S: бере замок квот - той самий, що й прийом аналізу
    S->>S: читає поточні лічильники як старі значення
    S->>D: спершу пише запис журналу - скидання квоти зі старими значеннями обох лічильників
    Note over S,D: persists запис журналу дій адміністратора (тип скидання квоти, адміністратор, uid, старі значення, час)
    alt запис журналу не вдався
        S->>S: відпускає замок, лічильники не змінює
        S-->>UI: зміну не застосовано, треба повторити
        UI-->>A: показує, що квоту не скинуто
    else журнал записано
        S->>Q: обнуляє сьогоднішні лічильники аналізів і транскрипцій вокалу, лічильник одночасних задач не чіпає
        Note over S,Q: persists денні лічильники квоти користувача
        alt запис квоти не вдався
            S->>D: дописує в журнал позначку не застосовано
            S->>S: відпускає замок
            S-->>UI: зміну не застосовано, треба повторити
            UI-->>A: показує, що квоту не скинуто
        else успіх
            S->>S: відпускає замок
            S-->>UI: нові лічильники 0 аналізів і 0 транскрипцій, одночасних задач 1
            UI-->>A: картка показує обнулену квоту
        end
    end
    Note over S,Q: AC-12b - прийом нового аналізу чекає на той самий замок, тож події йдуть по черзі
    alt аналіз прийнято до скидання
        Note over S,Q: скидання обнуляє і його - використання дорівнює 0
    else аналіз прийнято після скидання
        Note over S,Q: аналіз рахується - використання дорівнює 1, скидання його не стирає
    end
    Note over A,Q: Postcondition: користувач одразу може запустити новий аналіз, задача, що виконується, далі рахується в одночасні
```

### Персональний ліміт і чинний ліміт (US-08: AC-13, AC-13b, AC-14, AC-15)

```mermaid
sequenceDiagram
    autonumber
    actor A as <user> Адміністратор
    participant UI as <ui> адмінка
    actor U as <user> Користувач акаунта
    participant Site as <ui> сайт
    participant S as <service>
    participant D as <data-store>

    Note over A,D: Precondition: у користувача діє типовий ліміт 40 аналізів на добу
    A->>UI: задає персональний ліміт - 100 аналізів на добу до кінця місяця
    alt жодного числа, не ціле число, поза діапазоном або дата завершення в минулому
        UI-->>A: показує біля кожного поля допустимі значення, запит не надсилається
    else форма коректна
        UI->>S: зберігає персональний ліміт
        S->>S: повторно перевіряє поля - аналізи 1-1000, транскрипції 1-150, одночасні 1-4, дата не раніше сьогодні UTC
        alt значення недопустимі
            S-->>UI: помилки валідації за полями, без запису в журнал
            UI-->>A: показує допустимі значення біля полів
        else значення допустимі
            S->>D: один batched write - персональний ліміт і запис журналу з тим, що було і що стало
            Note over S,D: persists персональний ліміт (лише задані поля, дата завершення включно) і запис журналу
            alt запис не вдався
                S-->>UI: зміну не застосовано, треба повторити
            else успіх
                S-->>UI: картка з персональним лімітом і датою завершення
                UI-->>A: показує персональний ліміт
            end
        end
    end
    Note over UI,S: зміна і зняття ліміту йдуть тим самим шляхом, зняття видаляє ліміт і теж пише журнал
    U->>Site: запускає хмарний аналіз
    Site->>S: хмарна задача з ID-токеном
    S->>D: читає персональний ліміт, якщо кеш стану користувача старший за 60 с
    alt персональний ліміт чинний - сьогодні не пізніше дати завершення
        S->>S: задані поля беруться з персонального ліміту навіть нижче за типовий, незадані - з типового
    else дата завершення минула
        S->>S: усі поля беруться з типового ліміту, картка показує ліміт як завершився
    end
    S->>S: шлюз допуску зараховує задачу в межах чинного ліміту (Critical flow 2)
    Note over A,D: Postcondition: чинний ліміт = персональний до кінця дати завершення включно, далі типовий
```

### Зняття хмарного обмеження (US-09, US-10: AC-19, AC-23b)

```mermaid
sequenceDiagram
    autonumber
    actor A as <user> Адміністратор
    participant UI as <ui> адмінка
    participant S as <service>
    participant D as <data-store>

    Note over A,D: Precondition: користувач під хмарним обмеженням, задачі, прийняті до обмеження, завершуються звичайним чином (потік Проєкції)
    A->>UI: знімає хмарне обмеження
    UI->>S: знімає обмеження користувача
    S->>D: транзакція - читає поточний стан користувача
    alt у користувача заплановане видалення
        S->>D: пише запис журналу - відхилена спроба з причиною спершу скасувати видалення
        Note over S,D: persists запис журналу (тип відхилена спроба, адміністратор, uid, причина)
        S-->>UI: відмова - спершу треба скасувати видалення
        UI-->>A: показує, що єдина дія над станом - Скасувати видалення
    else хмарне обмеження
        S->>D: у тій самій транзакції знімає обмеження і пише запис журналу з тим, що було і що стало
        Note over S,D: persists стан користувача і запис журналу
        alt транзакція не вдалася
            S-->>UI: зміну не застосовано, треба повторити
        else успіх
            S-->>UI: новий стан картки - звичайний
            UI-->>A: картка показує звичайний стан
        end
    end
    Note over UI,S: накладання обмеження на користувача із запланованим видаленням відхиляється тим самим шляхом
    Note over A,D: Postcondition: не пізніше ніж за 60 с користувач знову запускає хмарні аналізи, усі пісні на місці
```

### Запланувати видалення (US-11: AC-17, AC-20, AC-21, AC-34, AC-35)

```mermaid
sequenceDiagram
    autonumber
    actor A as <user> Адміністратор
    participant UI as <ui> адмінка
    participant X as <external-system> провайдер входу
    participant S as <service>
    participant D as <data-store>

    Note over A,D: Precondition: користувач акаунта попросив видалити його дані, адміністратор відкрив його картку
    A->>UI: вибирає Видалити і вводить email користувача для підтвердження
    UI->>S: планує видалення з введеним email
    S->>S: перевіряє, що вхід адміністратора відбувся не давніше 15 хв, за часом входу з токена
    opt вхід давніше 15 хв
        S-->>UI: потрібен повторний вхід, дію не виконано
        UI->>X: просить адміністратора повторно ввести пароль
        X-->>UI: свіжий ID-токен
        UI->>S: повторює планування видалення зі свіжим токеном
    end
    alt ціль - власний акаунт адміністратора
        S->>D: пише запис журналу - відхилена спроба з причиною
        S-->>UI: відмова - адміністратор не може видалити власний акаунт
    else введений email не збігається з email користувача
        S-->>UI: відмова - треба ввести саме email цього користувача, помилка введення в журнал не йде
    else підтвердження коректне
        S->>S: бере замок ліміту запланованих видалень
        S->>D: рахує заплановані видалення всіма адміністраторами за останні 60 хв
        Note over S,D: reads журнал за тип запланування видалення і час, count (informs data-model index)
        alt уже 10 за останні 60 хв
            S->>D: пише запис журналу - відхилена спроба, перевищено ліміт видалень
            S-->>UI: відмова - не більше 10 запланованих видалень за будь-які 60 хв на всіх адміністраторів
        else менше 10
            S->>D: транзакція - зберігає попередній стан обмеження, ставить заплановане видалення з датою через 7 днів і хмарне обмеження, пише журнал
            Note over S,D: persists стан користувача (заплановане видалення, дата, попередній стан обмеження) і запис журналу - дата видалення читається фоновим проходом (informs data-model index)
            alt транзакція не вдалася
                S-->>UI: зміну не застосовано, треба повторити
            else успіх
                S-->>UI: картка - заплановане видалення з датою
                UI-->>A: показує заплановане видалення і дату через 7 днів
            end
        end
        S->>S: відпускає замок ліміту видалень
    end
    Note over A,D: Postcondition: хмарне обмеження діє не пізніше ніж за 60 с, остаточне видалення - Critical flow 3
```

### Скасувати видалення (US-11: AC-23)

```mermaid
sequenceDiagram
    autonumber
    actor A as <user> Адміністратор
    participant UI as <ui> адмінка
    participant S as <service>
    participant D as <data-store>

    Note over A,D: Precondition: у користувача заплановане видалення, 7 днів ще не минули
    A->>UI: натискає Скасувати видалення
    UI->>S: скасовує видалення користувача
    S->>D: транзакція - читає стан користувача
    alt видалення не заплановане або вікно вже минуло
        S-->>UI: відмова - скасовувати нічого або остаточне видалення вже почалося
        UI-->>A: показує актуальний стан
    else заплановане, вікно не минуло
        S->>D: у тій самій транзакції повертає попередній стан обмеження з тією самою причиною або знімає обмеження, пише журнал
        Note over S,D: persists стан користувача (без запланованого видалення) і запис журналу
        alt транзакція не вдалася
            S-->>UI: зміну не застосовано, треба повторити
        else успіх
            S-->>UI: картка - стан, що був до видалення
            UI-->>A: показує попередній стан
        end
    end
    Note over A,D: Postcondition: стан обмеження такий самий, як до запланування
```

### Типові ліміти (US-12: AC-24, AC-25, AC-13b)

```mermaid
sequenceDiagram
    autonumber
    actor A as <user> Адміністратор
    participant UI as <ui> адмінка
    participant S as <service>
    participant D as <data-store>

    Note over A,D: Precondition: типовий ліміт - 40 аналізів на добу
    A->>UI: змінює типовий ліміт аналізів на 30
    alt порожнє значення, нуль, від'ємне або поза діапазоном
        UI-->>A: пояснює допустимі значення і підказує перемикач Пауза нових аналізів, запит не надсилається
    else значення коректні
        UI->>S: зберігає типові ліміти
        S->>S: повторно перевіряє - аналізи 1-1000, транскрипції 1-150, одночасні 1-4, тривалість 1-120 хв, файл від 1 МБ до 0,5 ГБ
        alt значення недопустимі
            S-->>UI: помилки валідації за полями, без запису в журнал
            UI-->>A: показує допустимі значення
        else значення допустимі
            S->>D: один batched write - документ налаштувань і запис журналу зі старим і новим значенням
            Note over S,D: persists налаштування сервісу (типові ліміти) і запис журналу
            alt запис не вдався
                S-->>UI: зміну не застосовано, треба повторити
            else успіх
                S->>S: оновлює власний кеш налаштувань одразу
                S-->>UI: нові типові ліміти
                UI-->>A: показує нові значення
            end
        end
    end
    Note over S,D: кеш налаштувань живе 30 с і перечитується при наступному запиті - зміна чинна не пізніше ніж за 60 с без розгортання
    Note over S,D: AC-13b - задані поля персональних лімітів не змінюються, незадані підхоплюють нове типове значення при наступному допуску
    Note over A,D: Postcondition: користувачі без чинного персонального ліміту обмежені 30 аналізами на добу
```

### Перемикачі сервісу (US-13: AC-26, AC-27, AC-28, AC-34)

```mermaid
sequenceDiagram
    autonumber
    actor A as <user> Адміністратор
    participant UI as <ui> адмінка
    participant X as <external-system> провайдер входу
    participant S as <service>
    participant D as <data-store>

    Note over A,D: Precondition: адміністратор на екрані налаштувань
    A->>UI: перемикає паузу нових аналізів, завантаження з YouTube на сервері або транскрипцію вокалу
    UI->>S: змінює перемикач
    opt увімкнення паузи нових аналізів, а вхід давніше 15 хв
        S-->>UI: потрібен повторний вхід, дію не виконано
        UI->>X: просить адміністратора повторно ввести пароль
        X-->>UI: свіжий ID-токен
        UI->>S: повторює зміну перемикача зі свіжим токеном
    end
    S->>D: один batched write - закритий документ налаштувань, публічний стан перемикачів і запис журналу
    Note over S,D: persists налаштування сервісу, публічний стан сервісу (читає сайт без сервера) і запис журналу
    alt запис не вдався
        S-->>UI: зміну не застосовано, треба повторити
        UI-->>A: показує попередній стан перемикача
    else успіх
        S->>S: оновлює власний кеш налаштувань одразу
        S-->>UI: новий стан перемикачів
        UI-->>A: показує новий стан
    end
    Note over S,D: шлюз допуску бачить новий стан не пізніше ніж за 60 с, сайт - не пізніше ніж за 5 хв з публічного стану (Critical flow 2)
    Note over A,D: Postcondition: задачі, прийняті до зміни, завершуються - перемикачі перевіряються лише при прийомі задачі
```

### Банер обслуговування (US-14: AC-29, AC-30)

```mermaid
sequenceDiagram
    autonumber
    actor A as <user> Адміністратор
    participant UI as <ui> адмінка
    actor G as <user> Гість
    participant Site as <ui> сайт
    participant S as <service>
    participant D as <data-store>

    Note over A,D: Precondition: адміністратор на екрані налаштувань
    A->>UI: вводить текст банера українською й англійською і публікує
    alt текст порожній або довший за 250 символів хоча б однією мовою
        UI-->>A: пояснює, що текст обома мовами має бути від 1 до 250 символів, запит не надсилається
    else тексти коректні
        UI->>S: публікує банер
        S->>S: повторно перевіряє довжину обох текстів
        alt тексти недопустимі
            S-->>UI: помилка валідації, без запису в журнал
            UI-->>A: пояснює правило довжини
        else тексти допустимі
            S->>D: один batched write - банер у публічному стані сервісу і запис журналу
            Note over S,D: persists публічний стан сервісу (банер uk і en, увімкнено) і запис журналу
            alt запис не вдався
                S-->>UI: зміну не застосовано, треба повторити
            else успіх
                S-->>UI: банер опубліковано
                UI-->>A: показує опублікований банер
            end
        end
    end
    G->>Site: відкриває сайт
    alt збережений на пристрої публічний стан молодший за 5 хв
        Site->>Site: бере банер зі збереженого стану
    else стан старший за 5 хв або відсутній
        Site->>D: читає публічний стан сервісу напряму
        D-->>Site: банер і стан перемикачів
    end
    Site-->>G: показує банер мовою інтерфейсу як звичайний текст
    Note over Site,S: сервер не викликається - 0 запитів до хмарного сервера на показ банера
    Note over A,D: Postcondition: вимкнення банера йде тим самим шляхом, нові відвідування не бачать його не пізніше ніж за 5 хв
```

### Cross-cutting: допуск до адмінського API (US-15: AC-31, AC-32, AC-36)

```mermaid
sequenceDiagram
    autonumber
    actor P as <user> будь-хто з акаунтом
    participant UI as <ui> адмінка
    participant S as <service>
    participant D as <data-store>

    Note over P,D: Precondition: код адмінки публічний, але не містить ні даних, ні секретів - усе вирішує сервер
    P->>UI: відкриває адресу адмінки або виконує адмінську дію
    UI->>S: адмінський запит з ID-токеном
    S->>S: перевіряє ID-токен
    S->>D: читає allowlist адміністраторів, якщо кеш старший за 60 с
    Note over S,D: reads allowlist адміністраторів за uid - пише лише скрипт власника
    alt не адміністратор
        S->>S: рахує адмінські запити цього акаунта за останні 60 с, у пам'яті
        alt 30 або більше за останні 60 с
            S-->>UI: та сама відповідь, що й на неіснуючу адресу, запит не обробляється
        else менше 30
            S-->>UI: та сама відповідь, що й на неіснуючу адресу
        end
        UI-->>P: Сторінку не знайдено, без даних і без підказок про дії
    else адміністратор
        S->>S: передає запит обробнику адмінської дії чи читання
        S-->>UI: результат
        UI-->>P: показує дані адмінки
    end
    Note over S,D: AC-32 - після зняття позначки скриптом власника кеш allowlist протухає не пізніше ніж за 60 с, і наступний запит з відкритої адмінки отримує відповідь не знайдено
    Note over P,D: Postcondition: звичайні можливості користувача (бібліотека, аналізи) цей допуск не проходять і не обмежуються, на адміністраторів ліміт спроб не діє
```

### Проєкції з життєвого циклу задачі (US-01, US-04, US-10, US-11: AC-19, AC-22, AC-28)

```mermaid
sequenceDiagram
    autonumber
    actor U as <user> Користувач акаунта
    participant Site as <ui> сайт
    participant S as <service>
    participant D as <data-store>

    Note over U,D: Precondition: задачу допущено шлюзом допуску (Critical flow 2)
    S->>D: один batched write - запис історії задачі зі статусом виконується і атомарні інкременти лічильників доби
    Note over S,D: persists запис історії задачі (id = id задачі, uid, джерело, час прийому, статус) і лічильники доби UTC (прийнято за джерелами, активні користувачі) (informs data-model index)
    S->>S: виконує аналіз чи транскрипцію у фоні
    Note over S,D: хмарне обмеження чи перемикач, увімкнені після прийому, задачу не зупиняють
    alt задача завершилася успішно
        S->>D: перевіряє надгробок uid
        alt надгробок є - користувача остаточно видалено
            S->>S: відкидає результат, пісня в бібліотеку не пишеться
            S->>D: пише завершення в історію знеособлено, без назви пісні
        else надгробку немає
            S->>D: пише пісню в бібліотеку користувача
            S->>D: один batched write - успішне завершення в історії і лічильники доби
            Note over S,D: persists результат у записі історії задачі і лічильники доби
        end
    else задача впала
        S->>S: відображає код помилки на причину збою з фіксованого списку
        S->>D: один batched write - результат невдала з причиною і коротким текстом помилки, лічильник невдалих задач доби
        Note over S,D: persists причина збою в записі історії задачі (informs data-model index за результатом і причиною)
    end
    alt запис проєкції не вдався
        S->>S: логує помилку, задача користувача не страждає
        Note over S,D: розбіжність лічильників виправляє нічна звірка, незакритий запис закриває фонова робота з причиною Інше
    end
    Site->>S: отримує стан задачі існуючим механізмом
    S-->>Site: результат
    Site-->>U: пісня в бібліотеці або пояснення збою
    Note over U,D: Postcondition: кожна прийнята задача має запис в історії і внесок у лічильники доби
```

### Cross-cutting: фонові роботи (US-05, US-11: AC-22, AC-08)

```mermaid
sequenceDiagram
    autonumber
    participant C as <client> планувальник
    participant S as <service>
    participant D as <data-store>
    participant X as <external-system> провайдер входу

    Note over C,S: Trigger: розклад 00:15 і 12:15 UTC, або перше природне пробудження сервера після 00:00 UTC
    C->>S: будить фонові роботи з OIDC-токеном
    S->>S: перевіряє підпис, аудиторію й акаунт планувальника
    alt токен не від планувальника
        S-->>C: та сама відповідь, що й на неіснуючу адресу
    else токен коректний
        S->>S: check idempotency key - слот розкладу (дата і час), пропускає, якщо слот уже завершено або виконується
        S->>D: позначає слот проходу як виконується
        Note over S,D: persists позначка проходу фонових робіт (слот, стан, час)
        S->>D: звіряє вчорашній день з історією задач, виправляє й логує розбіжність, заморожує день
        Note over S,D: persists заморожена денна статистика
        S->>D: закриває задачі, що зависли після рестарту, з причиною Інше
        Note over S,D: reads історія задач за статусом виконується і часом прийому (informs data-model index)
        S->>D: виконує повну синхронізацію індексу email
        S->>D: остаточні видалення з минулим вікном - ідемпотентні кроки Critical flow 3
        S->>X: видаляє облікові записи в межах Critical flow 3
        X-->>S: облікові записи видалено
        S->>D: позначає слот проходу завершеним
        S-->>C: прохід завершено
    end
    Note over C,S: retry - при збої чи таймауті планувальник повторює виклик N разів з експоненційною затримкою, далі незавершене добирає наступний слот через 12 год
    alt видалення незавершене понад 24 год після кінця вікна
        S->>S: метрика deletion_overdue більше 0
        Note over S,X: dead-letter - алерт на email власника і ручний розбір, видалення лишається в черзі до завершення
    end
```

### Покриття user stories і AC

| US | Потоки |
|---|---|
| US-01 | Огляд адмінки; Проєкції з життєвого циклу задачі |
| US-02 | Пошук і картка користувача |
| US-03 | Пошук і картка користувача |
| US-04 | Історія задач; Проєкції з життєвого циклу задачі |
| US-05 | Статистика за період; Cross-cutting: фонові роботи |
| US-06 | Журнал дій адміністратора |
| US-07 | Скидання денної квоти |
| US-08 | Персональний ліміт і чинний ліміт; Critical flow 2 |
| US-09 | Critical flow 1; Зняття хмарного обмеження |
| US-10 | Critical flow 2; Зняття хмарного обмеження; Проєкції з життєвого циклу задачі |
| US-11 | Запланувати видалення; Скасувати видалення; Critical flow 3; Cross-cutting: фонові роботи |
| US-12 | Типові ліміти |
| US-13 | Перемикачі сервісу; Critical flow 2 |
| US-14 | Банер обслуговування |
| US-15 | Cross-cutting: допуск до адмінського API; Critical flow 1 |

| AC | Де показано |
|---|---|
| AC-01, AC-02 | Огляд адмінки (гілки: фонова вкладка, повернення до вкладки, Оновити) |
| AC-03, AC-04, AC-06 | Пошук і картка (гілки: коротший за 3 символи, Нікого не знайдено, сторінки по 50, лише метадані) |
| AC-05 | Пошук і картка (показ як звичайний текст) + **non-runtime**: сувора CSP і lint-заборона HTML-рендеру (ADR-0002, §8) |
| AC-07 | Історія задач |
| AC-08, AC-09 | Статистика за період (гілки валідації періоду); разове відновлення — **non-runtime**, одноразовий скрипт |
| AC-10, AC-11 | Журнал дій (позначка «видалений», немає дії змінити запис) |
| AC-10b | Пошук і картка (журнал пошуку й перегляду); Зняття обмеження, Запланувати видалення, Critical flow 1 (відхилені спроби); помилки валідації без журналу — у всіх формах |
| AC-12, AC-12b | Скидання денної квоти (гілка «аналіз до / після скидання») |
| AC-13, AC-13b, AC-14, AC-15 | Персональний ліміт і чинний ліміт; AC-13b також Типові ліміти |
| AC-16, AC-17 | Critical flow 1; AC-17 також Запланувати видалення |
| AC-18 | Critical flow 2 (відмова без квоти, пояснення, розпізнавання в браузері); робота бібліотеки — **non-runtime**: правила доступу до бібліотеки не змінюються |
| AC-19 | Проєкції з життєвого циклу задачі (обмеження не зупиняє прийняту задачу); Зняття хмарного обмеження |
| AC-20, AC-21, AC-34, AC-35 | Запланувати видалення; AC-34 також Перемикачі сервісу (пауза) |
| AC-22 | Critical flow 3; Проєкції (надгробок відкидає пізній результат); Cross-cutting: фонові роботи (ідемпотентність, повтори, dead-letter) |
| AC-23 | Скасувати видалення |
| AC-23b | Зняття хмарного обмеження (гілка «заплановане видалення») |
| AC-24, AC-25 | Типові ліміти |
| AC-26, AC-27, AC-28 | Перемикачі сервісу (зміна стану); Critical flow 2 (відмова при прийомі); Проєкції (прийняті задачі завершуються) |
| AC-29, AC-30 | Банер обслуговування |
| AC-31, AC-32, AC-36 | Cross-cutting: допуск до адмінського API; AC-31 також Critical flow 1 |
| AC-33 | Critical flow 1; Скидання денної квоти («журнал перший»); гілка «запис не вдався» в кожному потоці зміни |
| AC-33b | Пошук і картка (гілки «запис журналу не вдався») |

### Прапорці для design / data-model (з етапу sequences)

- **Seed-потоки 1–3 використовують конкретні назви учасників** (Firestore, Cloud Scheduler тощо), а нові потоки — узагальнені (`<service>`, `<data-store>` …). Seed-блоки не переписано; узгодити вручну, якщо потрібна однаковість.
- **Seed-потік 3 не показує ідемпотентність / повтори / dead-letter** — їх показує «Cross-cutting: фонові роботи». **Кандидати в ADR** (через `decide-adr`, не записано автоматично): ключ ідемпотентності проходу = слот розкладу з позначкою в сховищі; кількість повторів планувальника N.
- **Збій запису проєкції при прийомі задачі** (Проєкції): задача виконується, але запис в історії може бути відсутній, і нічна звірка (що рахує з історії) його не побачить. Політика повторів не визначена — ризик для NFR «Точність денної статистики»; вирішити в data-model/tasks (наприклад, локальний буфер за зразком `publish-pending.json`).
- **Публічний документ стану сервісу спільний для банера й перемикачів** — кожен batched write має оновлювати лише свої поля (merge), щоб не перетерти одне одним.
- **Запис журналу про пошук містить рядок пошуку** (частину email) — data-model має вирішити, чи знеособлювати його при остаточному видаленні (NFR «Повнота видалення»).
- **Незбіг email при підтвердженні видалення** вважається помилкою введення (у журнал не йде), узгоджено з AC-10b.
- **Скидання квоти тримає замок квот під час запису журналу** — прийом аналізів чекає на нього десятки мілісекунд; прийнятно при max 1 instance.
- **Нових учасників поза §5 немає**: `<external-system> провайдер входу` = Firebase Authentication, `<client> планувальник` = Cloud Scheduler.
- **Підказки індексів для data-model:** історія задач (результат × причина × джерело × час; статус × час прийому); журнал (адміністратор × користувач × тип × час; тип × час для ліміту 10 видалень / 60 хв); пісні власника за датою додавання (сторінки по 50); стан користувача за датою запланованого видалення; користувачі, створені після останньої синхронізації індексу email; денна статистика за ключем доби (читання за id).

## 7. Deployment view

<!-- 🎯 Why: the TOPOLOGY DevOps must know without reading the deploy charts — how many replicas,
     where the background worker lives, AT WHAT NUMBERS we scale.
     📋 Write: 2–3 sentences on topology + monitoring + concrete threshold numbers.
     📌 e.g. «500 authors → partition by quarter» (not «we'll think about scale later»).
     🎯 N/A allowed for XS/S that reuses an existing deployment unit with no change.
     Deployment-diagram scaffold → templates/deployment.md. -->

Нових сервісів немає. Той самий Cloud Run-сервіс (europe-west1, max 1 / min 0 instance, засинає за ~15 хв) отримує `/api/admin/*` і внутрішні фонові ендпоінти; `admin.html` збирається й деплоїться тим самим GitHub Pages workflow, що й сайт. Фонові роботи (остаточні видалення, звірка й заморожування вчорашнього дня, закриття «завислих» задач, повна синхронізація індексу email) запускаються **двічі на добу** — Cloud Scheduler о 00:15 і 12:15 UTC — і додатково самі при першому «природному» пробудженні сервера після 00:00 UTC. Чому двічі: видалення виконується ≤ 12 год після кінця вікна, а один упалий прохід ще вкладається в 24 год; ціна — до 30 хв роботи інстансу на добу в дні без живого трафіку (ризик KPI у §11).

**Infrastructure additions:**
- **Cloud Scheduler:** два завдання → внутрішній ендпоінт фонових робіт з OIDC-токеном окремого сервісного акаунта `chords-scheduler@…` (роль `run.invoker`); сервер перевіряє підпис, аудиторію й email цього акаунта.
- **Firestore:** TTL-політики (історія задач — `expireAt` = +90 днів; журнал дій адміністратора — `expireAt` = +400 днів, щоб гарантувати ≥ 365); складені індекси для фільтрів історії задач (результат × причина × джерело × час) і журналу (адміністратор × користувач × тип × час); `firestore.rules` — публічний документ стану сервісу: `allow read: if true`, запис заборонено; усі адмінські колекції: доступ клієнтів заборонено (лише сервісний акаунт).
- **Скрипт власника** `scripts/admin_grant.py` — видає/знімає позначку адміністратора з власними Google-правами власника (Application Default Credentials після `gcloud auth application-default login`), без файлу ключа й без сервісного акаунта сервера; запускається локально власником. Код сервера не має шляху запису в allowlist.
- **Збірка й CI:** друга точка входу Vite `admin.html`; CI-перевірка, що бандл адмінки не містить TF.js / моделей і що в `admin.html` є CSP-`<meta>`.
- **Конфіг сервера:** env-змінні `CHORDS_QUOTA_*` лишаються лише початковими значеннями для документа налаштувань (ADR-0005).

**Monitoring:**
- Лог-метрики (структуровані записи `chords.admin`): `admin_request` (маршрут, статус, тривалість — для availability ≥ 99% і p95 latency), `server_wake_by` (admin / scheduler / user — для KPI додаткових годин), `deletion_overdue` (кількість видалень, прострочених понад 24 год), `stats_mismatch` (розбіжність звірки дня), `audit_write_failed`.
- Алерти Cloud Monitoring на email власника: `deletion_overdue > 0`; `stats_mismatch > 0`. Це операційний нагляд за NFR у консолі хмари, як бюджетні сповіщення — не функція адмінки (spec §3 Non-goals).
- Tracing: не додається (у репо немає трасування; запит адмінки — один процес).

**Scaling thresholds:**
- Індекс email: один документ-шард до ~20 000 записів (межа 1 МБ); далі — додаткові шарди, пошук лишається ≤ 10 читань.
- Денні лічильники: один документ на добу витримує сталий ~1 запис/с — з max 1 instance і ≤ 2 одночасними задачами на користувача запас великий; при > 1 запису/с — шардовані лічильники.
- Max instances = 1 — передумова ADR-0003/ADR-0008 (квота під замком у процесі); підняття потребує перенесення лічильників квоти у Firestore-транзакції (§11).

## 8. Crosscutting concepts

<!-- 🎯 Why: CROSS-CUTTING PATTERNS spanning several modules: logging, errors, authorization, ID
     strategy, events, caching. ⭐ The second-densest section. A pattern inside one module is NOT
     here; a project-wide convention belongs in the convention file.
     📋 Write: a table — concept / convention / where defined. One row per concept.
     📌 e.g. «sortable time-based IDs generated in the app layer» as a default from the convention file. -->

| Concept | Convention | Where defined |
|---|---|---|
| Logging | Існуючі логери `chords.*` + новий `chords.admin`, stdout → Cloud Logging. **У логах лише uid — ніколи email, назви пісень, тексти банера чи причини обмеження** (інакше логи стають залишками після остаточного видалення) | `backend/app/*` (конвенція репо) + тут |
| Authentication | Існуючий middleware перевірки Firebase ID-токена; додатково віддає `auth_time` | `backend/app/auth.py` |
| Authorization | Allowlist адміністраторів у Firestore, перевірка на кожен `/api/admin/*`, кеш ≤ 60 с; не-адміністратору — відповідь, ідентична 404 FastAPI на неіснуючу адресу | ADR-0006 |
| Fresh login | Заплановане видалення й увімкнення паузи нових аналізів вимагають `auth_time` ≤ 15 хв, інакше адмінка просить повторний вхід | ADR-0006 |
| Probe rate limit | Не-адміністратор: понад 30 запитів до `/api/admin/*` за ковзні 60 с — відхиляються без обробки; лічильник у пам'яті процесу (max 1 instance); адміністраторів не стосується | тут (AC-36) |
| Audit | Пишуться зміни, відхилені спроби змін і перегляди особистих даних (пошук, картка); помилки валідації форм — ні. Batched write зі зміною або «журнал перший»; без запису — ні дії, ні даних | ADR-0007 |
| Output encoding / XSS | Лише текстовий рендер React; `dangerouslySetInnerHTML` і `innerHTML` заборонені lint-правилом у `frontend/src/admin/`; сувора CSP у `admin.html`; тест із набором шкідливих рядків для назв, джерел, текстів помилок і email | ADR-0002 |
| Error handling | Формат `{"detail", "code"}` + `STATUS_BY_CODE`; нові коди відмови допуску (обмежено / пауза / вимкнено) і адмінські коди валідації; тексти бекенду англійською, сайт і адмінка мапить коди на uk/en | `backend/app/main.py`, `models.py` |
| Time & ID strategy | Усе в UTC; ключ доби `YYYY-MM-DD` з `utc_day()`; id запису історії = id задачі (`secrets.token_hex(8)`); журнал — авто-ID Firestore + поле часу для сортування | `backend/app/quotas.py`, `jobs.py` |
| Caching | allowlist 60 с; стан користувача для допуску 60 с; налаштування 30 с (лінивий TTL); публічний стан на сайті 5 хв. **Жодного фонового опитування** ні на сервері, ні у відкритій вкладці адмінки (дані — при відкритті екрана, при поверненні до вкладки не частіше ніж раз на хвилину, або за «Оновити») | ADR-0005, AC-02 |
| Concurrency | Денна квота — замок у процесі (`Quotas`), скидання під тим самим замком; стан користувача (обмеження ↔ заплановане видалення ↔ скасування) — Firestore-транзакція; ліміт 10 запланованих видалень за ковзні 60 хв на всіх адміністраторів — під замком у процесі + count-запит до журналу | ADR-0003, ADR-0008 |
| Privacy | Адмінський API ніколи не віддає аудіо, акорди, правки — лише метадані пісень; причину хмарного обмеження бачать лише адміністратори; знеособлення при видаленні — без email і назв пісень | spec §6.1, ADR-0011 |
| Internationalisation | Домен `admin` у `frontend/src/i18n/{uk,en}.ts`; підписи причин збою uk/en; банер обслуговування зберігається двома мовами, сайт показує мовою інтерфейсу | конвенція репо |
| Events | Подій між модулями немає — хуки проєкцій у `JobManager` викликаються синхронно в процесі | ADR-0004 |

## 9. Architecture decisions

<!-- 🎯 Why: the REVERSE INDEX onto the adr/ folder. `ls adr/` gives the files; §9 gives the
     semantics — why they exist, which SAD section they attach to, what status.
     📋 Write: a 4-column table, one row per ADR. Mixed status is fine.
     📌 e.g. «0001 | Store content as a table of typed blocks | Accepted | §4». -->

| # | Title | Status | Section |
|---|---|---|---|
| [0001](adr/0001-build-admin-as-backend-service-and-web-frontend.md) | Build the admin as a backend-service plus a web-frontend, background work inside the backend | Accepted | §4 |
| [0002](adr/0002-ship-admin-ui-as-separate-strict-csp-entry.md) | Ship the admin UI as a separate admin.html entry with a strict CSP | Accepted | §4 |
| [0003](adr/0003-host-admin-api-in-existing-backend-service.md) | Host the admin API as a router inside the existing FastAPI service | Accepted | §4 |
| [0004](adr/0004-precompute-admin-read-model-in-firestore.md) | Precompute the admin read model as Firestore projections written at event time | Accepted | §4 |
| [0005](adr/0005-store-runtime-config-in-firestore-with-public-status-mirror.md) | Store runtime config in Firestore with a public status mirror read directly by the site | Accepted | §4 |
| [0006](adr/0006-authorize-admins-via-firestore-allowlist-with-60s-cache.md) | Authorize admins via a Firestore allowlist checked on every request with a 60-second cache | Accepted | §4 |
| [0007](adr/0007-write-audit-atomically-or-before-the-effect.md) | Write the audit record atomically with Firestore changes, and before any non-Firestore effect | Accepted | §4 |
| [0008](adr/0008-gate-every-cloud-job-through-one-admission-check.md) | Gate every cloud job through one admission check before the quota is consumed | Accepted | §5 |
| [0009](adr/0009-search-emails-in-memory-over-a-compact-firestore-index.md) | Search emails in memory over a compact sharded Firestore index, caught up incrementally from users | Accepted | §5 |
| [0010](adr/0010-count-daily-stats-live-and-freeze-after-nightly-reconciliation.md) | Count daily stats live at event time and freeze each day after a nightly reconciliation | Accepted | §5 |
| [0011](adr/0011-purge-accounts-tombstone-first-with-idempotent-steps.md) | Purge accounts tombstone-first, with idempotent steps and the auth record deleted after all data | Accepted | §6 |

ADR files live under `docs/features/admin/adr/NNNN-<title>.md`.

## 10. Quality requirements

<!-- 🎯 Why: the QUALITY TREE — take a goal from §1 and break it into concrete leaves: tests,
     metrics, configs, drills. ⭐ Without §10, §1 is a manifesto. With §10 each declaration maps
     to something PROVABLE.
     📋 Write: per §1 goal — When / Then / How-verify. Numbers from spec §6 NFR VERBATIM (don't
     round ≤250ms to ≤300ms — that's a critic F6 hit).
     📌 e.g. «p95 ≤ 500 ms on a block update, verified by a 100 req/s load test». -->

Each top-3 goal from §1 expanded into a full scenario (numbers verbatim from spec §6):

**QG-1. Безпека межі адміністратора**
- **When:** користувач акаунта без позначки адміністратора відкриває адресу адмінки або викликає будь-який адмінський маршрут; власник знімає позначку з довіреної людини; запис у журнал дій адміністратора не вдається; назва пісні містить розмітку чи код.
- **Then:** не-адміністратор бачить лише «Сторінку не знайдено» без підказок, які дії існують (AC-31); зняття прав адміністратора набуває чинності ≤ 60 с (spec §6 «Набуття чинності змінами, які застосовує сервер»); без запису в журнал дія не виконується, а дані перегляду не показуються (AC-33, AC-33b); назва показується дослівно як текст, нічого не виконується (AC-05).
- **How verify:** контрактний pytest, що перебирає **всі** маршрути адмінського роутера й порівнює відповідь для не-адміністратора з 404 неіснуючої адреси (новий маршрут без перевірки прав ламає CI); інтеграційний тест «прибрати з allowlist → перевіряти щосекунди» ≤ 60 с; fault-injection тест (зламаний batched write / недоступний журнал → стан не змінився, дані не віддано); vitest + e2e з набором шкідливих рядків у назві, джерелі, тексті помилки й email і перевіркою, що CSP `admin.html` блокує inline-скрипт.

**QG-2. Вартість і сон сервера**
- **When:** Адміністратор відкриває будь-який екран чи сторінку списку; вкладка адмінки лишається відкритою без дій; гість чи користувач акаунта відкриває сайт.
- **Then:** ≤ 200 читань сховища на один екран чи одну сторінку списку, незалежно від загальної кількості користувачів і пісень; відкрита вкладка адмінки без дій адміністратора (активна чи неактивна) створює 0 запитів до сервера, сервер засинає за звичайні ~15 хв; 0 запитів до хмарного сервера на показ банера й отримання стану перемикачів.
- **How verify:** лічильник читань емулятора Firestore для кожного адмінського ендпоінта на тестовому наборі 1 000 користувачів × 20 пісень і на одному користувачі з 1 000 пісень; журнал запитів сервера за 30 хв з відкритою вкладкою без дій — окремо активною й неактивною; журнал запитів сервера під час відкриття сайту гостем і користувачем акаунта.

**QG-3. Керованість без розгортання**
- **When:** Адміністратор змінює типові чи персональні ліміти, перемикачі сервісу, хмарне обмеження; власник знімає права адміністратора; Адміністратор публікує чи вимикає банер обслуговування або змінює перемикач.
- **Then:** зміни, які застосовує сервер, набувають чинності ≤ 60 с без повторного розгортання; поява чи зникнення банера обслуговування і нового стану перемикачів сервісу на сайті для нових відвідувань — ≤ 5 хв.
- **How verify:** інтеграційний тест «зміна → перевірка поведінки сервера щосекунди»; e2e-тест «зміна банера чи перемикача → відкриття сайту гостем і користувачем акаунта щохвилини».

**Additional scenarios (rest of spec §6):**

| Aspect | Then (spec §6, verbatim) | How verify |
|---|---|---|
| Latency огляду, сервер працює | p95 ≤ 2 с | вимір у браузері для 20 відкриттів адмінки, сервер прогрітий |
| Latency огляду, сервер спав | p95 ≤ 15 с | вимір від холодного старту, 5 спроб |
| Latency пошуку користувача | p95 ≤ 1 с при 10 000 користувачів | тест із синтетичними 10 000 користувачами (індекс email ADR-0009) |
| Повнота видалення | 100% запланованих видалень завершено протягом 24 год після кінця 7-денного вікна; 0 залишків особистих даних і вмісту (знеособлені записи журналу й історії задач без email і назв пісень — не залишки) | щоденна перевірка «заплановані vs стерті» + пошук об'єктів і email видалених користувачів, зокрема в індексі пошуку; алерт `deletion_overdue > 0` |
| Зберігання журналу | ≥ 365 днів, записи незмінні | перевірка TTL-політики (`expireAt` = +400 днів) + тест «змінити чи видалити запис через адмінку чи клієнтський доступ неможливо» |
| Зберігання історії задач | ≥ 90 днів | перевірка TTL-політики й найстарішого запису |
| Точність денної статистики | для кожного дня після запуску фічі, за який ще зберігається історія задач (90 днів): денні підсумки = кількості задач в історії за ту ж добу UTC, зокрема знеособлених задач видалених користувачів (розбіжність 0); підсумки завершеного дня після його кінця не змінюються; відновлені дні не звіряються | нічна звірка (ADR-0010) + алерт `stats_mismatch > 0`; тест «видалення користувача не змінює заморожений день» |
| Availability адмінки | ≥ 99% адмінських запитів за місяць без помилки сервера (холодний старт — затримка, не помилка) | лог-метрика `admin_request` за статусом |

## 11. Risks and technical debt

<!-- 🎯 Why: ⭐ collects EVERYTHING that can break — not only the technical. Without §11 risks get
     discussed at standups and lost; debt lives only in the head of whoever accepted it.
     📋 Write: a risk/debt table — severity — mitigation — owner. Accepted debt in its own block.
     📌 The first risk is often a product risk, not a technical one. That's normal. -->

<!-- Severity literals: Low / Medium / High for regular risks; "Open question" for rows created by
     a Save-as-OQ resolution during the Socratic walk (see references/socratic.md). -->

| Risk / debt | Severity | Mitigation | Owner |
|---|---|---|---|
| Коректність денної квоти, ліміту спроб не-адміністраторів і ліміту 10 видалень / 60 хв спирається на **max-instances = 1** (замки й лічильники в пам'яті процесу) | Medium | Перевірка значення в `scripts/deploy_cloud.sh` + попередження в лозі старту; шлях міграції — лічильники у Firestore-транзакції (ADR-0003, ADR-0008) | Tech Lead |
| **KPI «Додаткові години роботи сервера через адмінку ≤ 2%»** може не виконатися при малому органічному трафіку: відкриття адмінки + 2 пробудження планувальника на добу (§7) | Medium | Метрика `server_wake_by`; огляд за перший місяць після етапу 1; відкат на 1 пробудження/добу або винесення фонових робіт у Cloud Run Job | Власник |
| Дрейф проєкцій (довідник користувачів, лічильники дня, індекс email) від даних у GCS і `users` | Medium | Нічна звірка дня й повна синхронізація індексу; ідемпотентний backfill; алерт `stats_mismatch` | Backend |
| Публічний документ стану сервісу може випадково отримати зайві поля (ліміти, особисті дані) | Medium | Білий список полів у `admin/settings.py` + тест `firestore.rules` і вмісту документа | Security Lead |
| Повторна публікація з `publish-pending.json` або пізня задача може відновити трек видаленого користувача | Medium | Надгробок uid (ADR-0011) перевіряється у publish-шляху й шлюзі допуску; інтеграційний тест | Backend |
| Власний REST-клієнт Firestore (`backend/app/firestore.py`) ще не вміє batched write, транзакції, запити й count-агрегації | Medium | Розширити клієнт першою задачею етапу 1, тести на емуляторі Firestore | Backend |
| Скрипт власника — єдиний шлях видачі прав адміністратора; будь-хто з IAM-доступом на запис у Firestore проєкту теж може змінити allowlist | Medium | Скрипт працює з ADC власника (без файлу ключа на диску); IAM-доступ до проєкту — лише власник; зміни allowlist видно в Cloud Audit Logs під іменем власника; код сервера не пише в allowlist | Власник |
| Brownfield: задачі живуть лише в пам'яті — рестарт інстансу лишає записи історії в стані «виконується» | Low | Фонова робота закриває їх із причиною збою «Інше» (≤ 12 год) | Backend |
| Open architectural decision: дедлайн і бюджет зусиль на три етапи | Open question | Resolve before `sdd:tasks`; §2 Organisational — `<TBD by PM>` | Власник |
| Open question (spec §8): адреса чи канал підтримки в поясненні хмарного обмеження | Open question | Resolve before `sdd:tasks`; default — email власника з README | Власник |
| Open question (spec §8): чи рахувати службовий акаунт smoke-test у статистиці й списку користувачів | Open question | Resolve before `sdd:data-model`; default — показувати окремо з позначкою «службовий», у статистику не враховувати | Власник |

**Spec §8 questions resolved at design (2026-10-07, owner: Власник):**
- **2FA для входу адміністратора — ні у v1.** Компенсація: свіжий вхід ≤ 15 хв для запланованого видалення й паузи нових аналізів, 7-денне вікно видалення, ліміт 10 запланованих видалень / 60 хв, журнал переглядів. Архітектура не блокує 2FA пізніше (Identity Platform + перевірка фактора в `admin/authz.py`).
- **Листи користувачам — ні у v1.** Користувач під хмарним обмеженням чи запланованим видаленням бачить на сайті те саме пояснення хмарного обмеження, без дати видалення. Позначити ці два OQ закритими в `spec.md` — окремим кроком власника.

**Accepted debt (acceptable in v1, plan to fix later):**
- Без 2FA для адміністратора у v1 (див. вище) — security debt, переглянути перед додаванням другого адміністратора.
- Зміна email користувачем потрапляє в індекс пошуку лише при наступній повній синхронізації (≤ 12 год).
- Завантаження в Storage від обмежених користувачів (вхід через запис вкладки) лежать до звичайного очищення завантажень.

## 12. Glossary

<!-- 🎯 Why: ⭐ the DOMAIN GLOSSARY that ends arguments a year later («checkpoint — weekly or
     biweekly? quarter — calendar or fiscal?»).
     📋 Write: a term / meaning table. Business + technical terms mixed.
     📌 e.g. «Lesson | a unit inside a course made of blocks (text, video)». -->

Domain terms are canonical in [CONTEXT.md](./CONTEXT.md) — this table only points at them and adds the architecture terms introduced by this SAD.

**From CONTEXT (used in this SAD):** Адміністратор · Користувач акаунта · Гість · Денна квота · Типовий ліміт · Персональний ліміт · Хмарне обмеження · Заплановане видалення · Перемикач сервісу · Банер обслуговування · Журнал дій адміністратора · Історія задач · Денна статистика · Причина збою · Активний користувач · Новий користувач.

**Architecture terms introduced here** (not yet in CONTEXT — candidates for a `sdd:glossary admin` follow-up):

| Term | Meaning |
|---|---|
| Шлюз допуску | Єдина перевірка перед зарахуванням у денну квоту, через яку проходить кожна хмарна задача: хмарне обмеження / заплановане видалення → перемикачі сервісу → чинний ліміт (ADR-0008). NOT перевірка прав адміністратора. |
| Allowlist адміністраторів | Закритий список uid з позначкою адміністратора у Firestore, який пише лише скрипт власника (ADR-0006). NOT custom claim у токені. |
| Свіжий вхід | Вхід адміністратора не давніше 15 хв за полем `auth_time` ID-токена; потрібен для запланованого видалення й паузи нових аналізів. |
| Проєкція | Заздалегідь порахований документ Firestore, який сервер оновлює в момент події, щоб екран адмінки читав готове (ADR-0004). NOT джерело правди для треків (вони в бакеті). |
| Індекс email | Компактні документи-шарди з парами uid → email малими літерами для пошуку підрядка в пам'яті сервера (ADR-0009). |
| Публічний стан сервісу | Публічно читаний документ Firestore лише з банером обслуговування й станом перемикачів сервісу; сайт читає його напряму, не будячи сервер (ADR-0005). NOT налаштування сервісу (типові ліміти там відсутні). |
| Заморожений день | День денної статистики після нічної звірки: його підсумки більше не змінюються, зокрема після видалення користувача (ADR-0010). |
| Надгробок | Запис «uid видалено», що ставиться першим кроком остаточного видалення, щоб пізні результати задач і повторні публікації відкидалися (ADR-0011). |
| Фонові роботи | Внутрішні ендпоінти сервера, які Cloud Scheduler будить двічі на добу: остаточні видалення, звірка дня, закриття «завислих» задач, синхронізація індексу email (§7). |
