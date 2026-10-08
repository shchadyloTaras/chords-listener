---
status: Draft
owner: "QA (Тарас Щадило)"
reviewers: ["implementing engineer", "Tech Lead", "Security Lead"]
updated_at: "2026-10-08"
feature_size: "L"
target_surfaces: [backend-service, web-frontend]  # read from sad.md frontmatter → adds component / visual-regression / e2e-through-UI tiers
---

# Test plan — admin

Власна адмінка Chords Listener: Адміністратор бачить стан хмари (огляд доби, користувачі й картки, історія задач, статистика, журнал), діє над користувачами акаунтів (скидання квоти, персональний ліміт, хмарне обмеження, заплановане видалення) і змінює налаштування сервісу (типові ліміти, перемикачі, банер) без повторного розгортання — права перевіряє сервер на кожен запит, і без запису в журнал ні дія, ні перегляд особистих даних не відбувається.

Кожен AC зі `spec.md §5` (42 шт.) нижче має ≥ 1 тест; рівні підтверджені користувачем 2026-10-08. Колонка **Task** — підказка для `implement`, у якій задачі з `tasks.json` пишеться червоний тест.

## Levels

| Level | Scope | Strategy (generic — no tool names) |
|---|---|---|
| Unit | Чисті правила без I/O: розрахунок чинного ліміту, валідатори діапазонів (ліміти, період, банер, пошуковий рядок), підрядковий пошук email без регістру, мапа причин збою, збіг email для підтвердження, ковзне вікно «30 запитів / 60 с», «10 видалень / 60 хв», «свіжий вхід ≤ 15 хв», політика оновлення адмінки (без опитування, не частіше ніж раз на хвилину). | У пам'яті; час — через керований годинник. |
| Integration | Адмінський модуль проти справжнього сховища, яким він володіє: транзакції дії + запис журналу, проєкції історії задач і статистики, індекс email, кеш налаштувань, ворота прийому хмарних задач, фонове прибирання й остаточне видалення. | Ефемерний емулятор документної БД — піднімається раз на набір, очищається після кожного тесту. Жодного мок-сховища. Збій запису журналу — через навмисне зламаний запис (fault injection), а не підмінене сховище. |
| Contract | Межа сервер ↔ адмінка: справжні відповіді адмінського API звіряються з `contracts/openapi.yaml`; перелік маршрутів адмінського роутера (жоден без перевірки прав); межа сервер ↔ сайт: форма публічного документа стану (`publicStatus/current`), яку пише сервер і читає сайт. | Валідувати справжню відповідь / справжній документ проти погодженої схеми; без рукописних заглушок. |
| E2E | Повний потік через справжню точку входу сервера проти ефемерних залежностей: Critical flow 3 (запланувати → минуло 7 днів → фонове прибирання → акаунт стерто); поширення змін ≤ 60 с. | Справжній сервер + емулятор; час — керований годинник, крім NFR-вимірів поширення (реальний час): live-набір `frontend/e2e-live/`. |
| Load | Лише NFR з числом: латентність огляду (теплий / холодний сервер), латентність пошуку при 10 000 користувачів. | Інструмент навантаження, що вже є в репозиторії, або напр. k6 чи Locust. |
| Component | Кожен екран адмінки й сайтові частини (банер, відмови прийому) в ізоляції: дані → відрендерений вивід + взаємодії, підказки біля полів форм. | Рендер у компонентному харнесі з підставленими відповідями API; без запуску всього застосунку. |
| Visual-regression | 4 знімки: огляд адмінки; картка користувача у 3 станах (звичайний / хмарне обмеження / заплановане видалення); екран налаштувань; банер обслуговування на сайті (UA і EN). | Знімок рендеру vs затверджений еталон; еталон оновлюється лише свідомо. |
| E2E-through-UI | Потоки через справжній інтерфейс у браузері: шкідливі рядки + CSP, видалення з підтвердженням email і повторним входом, пауза, банер і YouTube-off для гостя, «Сторінку не знайдено» для не-адміна, вкладка без дій не будить сервер. | Справжній UI + сервер + емулятор; журнал запитів сервера як доказ «0 запитів». Два набори: `frontend/e2e/` (зібрана адмінка, мережа підставлена, керований годинник; на кожен PR) і **live** `frontend/e2e-live/` (`npm run test:e2e:live`: браузер + справжній бекенд у хмарному режимі + емулятори Auth / Firestore / Storage, реальний час; access-лог сервера — доказ «0 запитів»; щоночі в `.github/workflows/admin-live-e2e.yml`). |

## AC coverage

| AC (spec.md §5) | Test name (intent-based) | Level | Expected outcome | Task |
|---|---|---|---|---|
| AC-01 огляд доби | `overview shows current UTC day totals, running jobs and switch states` | integration | Аналізи (за джерелами), транскрипції, невдалі задачі, активні й нові користувачі за поточну добу UTC збігаються з посіяними задачами; задачі, що виконуються, і стан кожного перемикача присутні | T11, T15 |
| AC-01 | `overview totals roll over at UTC midnight` | unit | Задача о 23:59:59 UTC рахується у вчорашню добу, о 00:00:00 — у нову | T11 |
| AC-01 | `overview screen renders every total and switch` | component | Усі підсумки, список задач і перемикачі видимі | T29 |
| AC-02 сон сервера | `refresh policy never polls and throttles tab-return to once a minute` | unit | Без таймера оновлення; повернення до вкладки через 30 с не оновлює, через 61 с — оновлює; кнопка «Оновити» оновлює завжди | T28 |
| AC-02 | `idle admin tab sends no requests` | e2e-through-UI (`frontend/e2e/admin.spec.ts` «an admin tab left alone for 30 minutes…», керований годинник; live: `frontend/e2e-live/idle-tab.spec.ts` «AC-02 @slow: admin tabs left alone for 30 real minutes…» — 30 хв реального часу, лише з `LIVE_SLOW=1`, щоночі) | За вікно спостереження з відкритою вкладкою без дій (окремо активною й фоновою) журнал запитів сервера порожній | T29, T38 |
| AC-03 пошук і картка | `email search matches substring anywhere case-insensitively` | unit | «ivan» знаходить і «ivan.p@…», і «John.Ivanov@…» | T16 |
| AC-03 | `user card shows profile, quota usage, personal limit and state` | integration | Картка містить дату реєстрації, останній вхід, кількість пісень, зайняте місце, використання квоти щодо ліміту, персональний ліміт і стан | T17 |
| AC-03 | `user songs are paged by 50 newest first` | integration | 120 пісень → сторінки 50/50/20, від нових до старих | T17 |
| AC-03 | `admin finds user and opens card through the UI` | component (`frontend/src/admin/screens/UserCard.test.tsx`: «lists every match with a link to its card», «shows registration, last login, songs, storage and quota…»); без браузера | Пошук «ivan» показує обох; картка відкривається з усіма полями | T30 |
| AC-04 закороткий / без збігів | `search shorter than 3 characters is not executed` | unit | Рядок < 3 символів відхилено валідатором, пошук не виконано | T04 |
| AC-04 | `search with no matches reports nobody found` | integration | Порожній результат; запит пошуку записаний у журнал | T17 |
| AC-04 | `search box asks for 3 characters and shows «Нікого не знайдено»` | component | Підказка про мінімум 3 символи; для порожнього результату — «Нікого не знайдено» | T30 |
| AC-05 текст лише текст | `hostile strings render verbatim as text` | component | Кожен рядок з набору шкідливих рядків у назві, джерелі, тексті помилки й email показаний дослівно; жодного нового елемента чи обробника в DOM | T30 |
| AC-05 | `admin page blocks inline script via its security policy` | e2e-through-UI | Пісня з назвою-скриптом: сторінка не виконує скрипт, політика безпеки сторінки відхиляє вбудований скрипт | T27, T38 |
| AC-06 лише метадані | `user track list exposes metadata only` | contract | Відповідь списку пісень містить лише назву, джерело, дату, тривалість, статус, причину збою — жодного посилання на аудіо, акордів чи правок; схема не дозволяє зайвих полів | T17 |
| AC-06 | `song rows offer no open or play action` | component | У рядку пісні немає дії відкрити / прослухати | T30 |
| AC-07 невдалі задачі | `failure reason maps to a fixed category with a plain-words label` | unit | Кожна відома помилка → категорія з фіксованого списку; невідома → «Інше» | T11 |
| AC-07 | `job history filters by outcome and source with per-category counts` | integration | Фільтр «невдала» + «YouTube» за 7 днів повертає лише такі задачі з користувачем, часом, джерелом, причиною; лічильники за категоріями збігаються | T18 |
| AC-07 | `job history screen shows filters, reasons as text and category counts` | component | Текст помилки показаний як звичайний текст; лічильники видимі | T31 |
| AC-08 статистика | `30-day stats return one row per day with restored days flagged` | integration | 30 рядків; дні до запуску позначені «відновлено з пісень» і містять лише кількість пісень за джерелами | T18, T08 |
| AC-08 | `restore migration builds pre-launch days from existing tracks` | integration | Після разового відновлення кількість пісень за джерелами на кожен день = посіяним пісням того дня | T08 |
| AC-08 | `stats screen marks restored days` | component | Відновлені дні візуально позначені, без колонок помилок і відмов | T31 |
| AC-09 неприпустимий період | `stats period longer than 90 days or reversed is rejected` | unit | 91 день і «кінець раніше за початок» відхилено; 90 днів — прийнято | T04 |
| AC-09 | `stats endpoint refuses an invalid period without building stats` | integration | Статистику не побудовано, пояснення про межі періоду | T18 |
| AC-09 | `stats form explains the period rule` | component | Пояснення про ≤ 90 днів і порядок дат видиме | T31 |
| AC-10 журнал | `audit list shows actions newest first with who, when, target, before and after` | integration | Скидання квоти й зміна типового ліміту — у зворотному порядку з «було» і «стало» | T19 |
| AC-10 | `audit screen renders entries` | component | Кожен запис показує хто, коли, над ким / яким налаштуванням, було → стало | T32 |
| AC-10b журнал переглядів | `search, card view and refused attempt are journaled` | integration | Три записи: рядок пошуку, перегляд картки (над ким), відхилена спроба самообмеження з причиною | T10, T17, T21 |
| AC-10b | `form validation errors are not journaled` | integration | Неприпустимі числа й порожній текст у будь-якій формі — 0 нових записів журналу | T10, T20, T23 |
| AC-11 незмінність журналу | `audit entries of a purged user remain and show «видалений»` | integration | Записи на місці, користувач показаний як «видалений» без email | T19, T25 |
| AC-11 | `admin API has no operation to modify or delete an audit entry` | contract | Ні в контракті, ні серед маршрутів роутера немає зміни чи видалення запису журналу; правила доступу клієнтів відхиляють запис у журнал | T06, T19 |
| AC-12 скидання квоти | `quota reset zeroes both counters and keeps running job in concurrency` | integration | Лічильники аналізів і транскрипцій = 0; новий аналіз приймається; задача, що виконується, і далі займає місце в межі одночасних; запис журналу зі старими значеннями обох лічильників | T20 |
| AC-12 | `quota reset action updates the card` | component | Після підтвердження картка показує нульове використання | T33 |
| AC-12b одночасність | `quota reset and concurrent admission never lose an analysis` | integration | Обидва порядки двох транзакцій (скидання → прийом, прийом → скидання) дають використання = кількості аналізів, прийнятих після скидання | T14, T20 |
| AC-13 персональний ліміт | `effective limit uses personal value for set fields only` | unit | Аналізи = 100, транскрипції й одночасні — типові | T14 |
| AC-13 | `personal limit lets the user run up to 100 analyses` | integration | 41-й…100-й аналізи приймаються, 101-й — ні; картка показує ліміт і дату; запис у журналі | T20, T14 |
| AC-13 | `personal limit form saves and shows the end date` | component | Картка показує персональний ліміт і дату завершення | T33 |
| AC-13b пріоритет персонального | `personal value wins even below default and unset field follows default` | unit | Персональні 5 аналізів < типових 40 → діють 5; транскрипції після зміни типового на 10 → діють 10 | T14 |
| AC-13b | `changing default vocal limit applies to unset personal field` | integration | Після зміни типового ліміту транскрипцій користувач обмежений 10 транскрипціями й 5 аналізами | T14, T23 |
| AC-14 неприпустимий персональний ліміт | `personal limit validator enforces ranges, integers, at-least-one and end date` | unit | Відхилено: жодного числа, не ціле, 0 / 1001 аналізів, 0 / 151 транскрипцій, 0 / 5 одночасних, вчорашня дата; прийнято межі 1/1000, 1/150, 1/4, сьогодні | T04 |
| AC-14 | `invalid personal limit is not saved` | integration | Ліміт не змінено, журнал без запису | T20 |
| AC-14 | `personal limit form explains each invalid field` | component | Біля кожного поля — допустиме значення | T33 |
| AC-15 завершення ліміту | `personal limit applies through end date inclusive in UTC` | unit | Останній день — персональний; наступна доба UTC — типовий (межа 23:59:59 / 00:00:00) | T14 |
| AC-15 | `expired personal limit falls back to default and card shows «завершився»` | integration | 41-й аналіз сьогодні відхилено; картка показує «завершився» | T14, T17 |
| AC-16 хмарне обмеження | `restriction is stored with reason and journaled` | integration | Стан «хмарне обмеження», причина й дата в картці; запис журналу | T21 |
| AC-16 | `restricted user's new cloud jobs are refused within a minute` | integration (керований годинник: `backend/tests/test_admission.py` «a restriction takes effect within a minute») + e2e-through-UI live (`frontend/e2e-live/restriction.spec.ts` «AC-16: a restricted user's next cloud analysis is refused within a minute, the site explains it, the journal shows it»: обмеження з картки, `POST /api/jobs` щосекунди, межа 60 с) | Від моменту обмеження нові аналізи й транскрипції відхиляються не пізніше ніж за 60 с (реальний час, перевірка щосекунди) | T13, T14, T21 |
| AC-16 | `restriction action shows state and reason on the card` | component | Стан і причина видимі лише в адмінці | T34 |
| AC-17 самодія | `admin cannot restrict or schedule deletion of own account` | integration | Обидві дії не виконані, пояснення; відхилені спроби записані в журнал | T21, T22 |
| AC-18 досвід обмеженого | `restricted user is refused at every cloud job entry without spending quota` | integration | Посилання YouTube, завантаження файлу, повторний аналіз, транскрипція вокалу — усі відхилені; квота не змінилась; відповідь без причини від адміна | T14 |
| AC-18 | `restricted user keeps full library access` | integration | Перегляд, редагування акордів, нотатки й видалення власних пісень працюють як раніше | T14 |
| AC-18 | `site explains restriction with contact and offers in-browser recognition` | component + e2e-through-UI live (`frontend/e2e-live/restriction.spec.ts`: завантаження файлу на сайті → 403 `cloud_restricted` → пояснення й кнопка «У браузері», причини від адміна на сторінці немає) | «Хмарний аналіз для вашого акаунта обмежено», адреса для звернення, пропозиція розпізнати в браузері | T37 |
| AC-19 прийняті задачі | `jobs accepted before restriction complete into the library` | integration | Задача, прийнята до обмеження, завершується, пісня з'являється | T12 |
| AC-19 | `lifting restriction restores cloud analysis without data loss` | integration | Після зняття новий аналіз приймається; усі пісні на місці | T21 |
| AC-20 запланувати видалення | `confirmed deletion is scheduled 7 days out with immediate restriction` | integration | Стан «заплановане видалення» з датою +7 днів; хмарне обмеження діє одразу; запис у журналі | T22 |
| AC-20 | `admin schedules deletion by typing the user's email` | component (`frontend/src/admin/actions/RestrictionActions.test.tsx`: «schedules the deletion once the email is typed and shows the state with the date») + e2e-through-UI live (`frontend/e2e-live/purge.spec.ts`: свіжий вхід, email у діалозі, `purgeAfter` = +7 днів) | Підтвердження email → картка показує заплановане видалення з датою | T34 |
| AC-21 хибний email | `deletion confirm email must match exactly` | unit | Інший email відхилено; правило порівняння задокументоване тестом (регістр / пробіли) | T22 |
| AC-21 | `mismatched email does not schedule deletion` | integration | Видалення не заплановане, пояснення | T22 |
| AC-21 | `deletion dialog explains the email rule` | component | Пояснення «введіть саме email цього користувача» | T34 |
| AC-22 остаточне видалення | `account is purged after the 7-day window` | integration (керований годинник; `backend/tests/admin/test_purge.py`: «a due account is purged everywhere», «nothing of the purged user is left anywhere…») + e2e live (`frontend/e2e-live/purge.spec.ts` «AC-22: after the 7 days and the sweep the account is gone everywhere…»: `purgeAfter` зсунуто в минуле в емуляторі, прибирання запускає той самий `Sweeper` + `Purger`, що будує сервер, через `backend/scripts/live_e2e.py sweep` — HTTP-вхід `/api/internal/sweep` приймає лише підписаний Google OIDC-токен планувальника, локально його не отримати) | Керований годинник +7 днів → фонове прибирання → акаунт, пісні, аудіо, правки, квоти й ліміти стерто; вхід неможливий | T24, T25 |
| AC-22 | `purge is idempotent and safe to retry` | integration | Повторний запуск прибирання після часткового збою доводить видалення до кінця без помилок | T25 |
| AC-22 | `late job result for a purged user is discarded` | integration | Задача, що завершилась після видалення, не повертає пісню | T12, T25 |
| AC-22 | `purge anonymizes audit and job history and keeps frozen days unchanged` | integration + e2e-through-UI live (`frontend/e2e-live/purge.spec.ts`: екрани «Журнал» і «Задачі» без email і назв, рядки «видалений» / «Користувача видалено»; пошук email → «Нікого не знайдено») | Записи журналу й історії без email і назв пісень, користувач «видалений»; підсумки завершених днів не змінились; email відсутній в індексі пошуку | T25 |
| AC-23 скасувати видалення | `cancelling deletion restores the prior restriction state` | integration | Без попереднього обмеження → звичайний стан; з попереднім → те саме обмеження з тією самою причиною; запис у журналі | T22 |
| AC-23 | `cancel deletion action on the card` | component | Після скасування картка показує попередній стан | T34 |
| AC-23b обмеження під видаленням | `restriction changes are refused while deletion is scheduled` | integration | Накласти / зняти обмеження відхилено з поясненням «спершу скасуйте видалення» | T21 |
| AC-23b | `card offers only «Скасувати видалення» for a scheduled user` | component | Інші дії над станом недоступні | T34 |
| AC-24 типовий ліміт | `default limit change applies within a minute without redeploy` | integration (керований годинник; `backend/tests/admin/test_actions_settings.py` «default limit change applies without redeploy within a minute», `backend/tests/admin/test_nfr.py` «a default limit changed on one instance applies on another within a minute») + e2e-through-UI live (`frontend/e2e-live/default-limit.spec.ts` «AC-24: a new default limit applies within a minute without a redeploy…»: екран «Налаштування», `GET /api/me` щосекунди, межа 60 с; 31-й аналіз дня відхилено; той самий процес сервера) | Зміна 40 → 30: не пізніше ніж за 60 с користувачі без чинного персонального ліміту обмежені 30 (реальний час, перевірка щосекунди); журнал зі старим і новим значенням | T13, T23 |
| AC-24 | `default limit change is journaled and mirrored` | integration | Налаштування оновлене, запис журналу з було / стало | T23 |
| AC-25 неприпустимий типовий ліміт | `default limits validator enforces every range` | unit | Відхилено порожнє, 0, від'ємне й поза діапазоном; прийнято межі 1–1000, 1–150, 1–4, 1–120 хв, 1 МБ–0,5 ГБ | T04 |
| AC-25 | `invalid default limits are not saved` | integration | Налаштування не змінене, журнал без запису | T23 |
| AC-25 | `settings form explains ranges and points to the pause switch` | component | Допустимі значення біля полів; підказка про «Пауза нових аналізів» | T35 |
| AC-26 пауза | `pause refuses new cloud analyses without spending quota` | integration | Посилання й файл відхилені з поясненням про паузу; квота не змінилась | T14, T23 |
| AC-26 | `jobs accepted before pause complete` | integration | Прийнята до паузи задача завершується | T12, T14 |
| AC-26 | `user sees pause explanation and in-browser option` | component (`frontend/src/components/chords/vocalsRefusal.test.tsx`, `frontend/src/components/layout/TrackActions.refusal.test.tsx`: пояснення про паузу) + e2e-through-UI live (`frontend/e2e-live/pause.spec.ts` «AC-26: with the pause on, a user's upload is refused without spending quota, explained, and offered in the browser»: пауза з екрана «Налаштування», завантаження на сайті → 503 `analyses_paused`, пояснення й кнопка «У браузері», квота не змінилась) | Після паузи користувач на сайті бачить пояснення й пропозицію розпізнати в браузері | T35, T37 |
| AC-27 YouTube вимкнено | `public status document matches the agreed shape` | contract | Документ, який пише сервер, валідується схемою, яку читає сайт (банер UA/EN + стан перемикачів) | T13, T36 |
| AC-27 | `site offers «Слухати у вкладці» without contacting the server` | component (`frontend/src/components/input/startLink.test.ts`: «signed in on the cloud: «Слухати у вкладці» is offered at once, without a request»; `frontend/src/lib/serviceStatus.test.ts`: читання статусу без запиту до сервера) + e2e-through-UI live (`frontend/e2e-live/banner.spec.ts` «NFR / AC-27: a switch turned off reaches the next visit at once…»: до вимкнення посилання веде до вибору фрагмента, після — одразу до «Слухати у вкладці»; access-лог сервера порожній) | При вимкненому YouTube сайт одразу пропонує «Слухати у вкладці»; журнал запитів сервера порожній для цієї спроби | T36 |
| AC-27 | `stale site is refused by server without spending quota` | integration | Сервер відхиляє YouTube-спробу з ознакою «вимкнено»; квота не змінилась; прийняті раніше завантаження завершуються | T14 |
| AC-28 транскрипція вимкнена | `vocal transcription off refuses without spending quota` | integration | Транскрипцію не запущено, квота не змінилась; аналіз акордів і бібліотека працюють; прийняті транскрипції завершуються | T14, T12 |
| AC-28 | `site explains transcription is temporarily unavailable` | component | Пояснення показане, акорди доступні | T37 |
| AC-29 банер | `guest sees banner in UI language without waking the server` | component (`frontend/src/components/layout/ServiceBanner.test.ts`: «a guest sees the banner in the interface language, and no request goes to any server») + e2e-through-UI live (`frontend/e2e-live/banner.spec.ts` «AC-29: a guest sees the published banner in the interface language without waking the server…»: публікація з екрана «Налаштування», новий візит гостя, UA → EN; запити браузера до сервера й access-лог сервера порожні; після вимкнення новий візит банера не показує) | Гість бачить банер мовою інтерфейсу (UA і EN); журнал запитів сервера порожній | T36 |
| AC-29 | `banner publish writes the public status mirror and journal` | integration | Публічний документ містить обидва тексти; запис журналу | T23 |
| AC-29 | `site banner matches approved baseline` | visual-regression (`frontend/e2e-live/banner.spec.ts`: `toHaveScreenshot('banner-uk.png')`, `toHaveScreenshot('banner-en.png')`; еталони залежать від платформи: `banner.spec.ts-snapshots/*-darwin.png` у репозиторії, Linux — разовим запуском workflow, див. docs/CLOUD.md «Live e2e») | Знімок банера UA і EN збігається з еталоном | T36 |
| AC-30 неприпустимий банер | `banner text must be 1–250 characters in both languages` | unit | Відхилено порожній і 251 символ будь-якою мовою; прийнято 1 і 250 | T04 |
| AC-30 | `invalid banner is not published` | integration | Публічний документ не змінився, журнал без запису | T23 |
| AC-30 | `banner form explains the length rule` | component | Пояснення «від 1 до 250 символів обома мовами» | T35 |
| AC-31 не-адмін | `every admin route answers a non-admin exactly like an unknown route` | contract | Для кожного маршруту адмінського роутера (перелік береться з самого роутера) відповідь не-адміну ідентична «не знайдено» для неіснуючої адреси; новий маршрут без перевірки прав ламає тест | T09 |
| AC-31 | `non-admin opening the admin page sees only «Сторінку не знайдено»` | component (`frontend/src/admin/AdminApp.test.ts`: «shows a non-admin only «Сторінку не знайдено»», «answers a failed access check exactly like a non-admin») | Жодних даних, назв дій чи меню адмінки | T27 |
| AC-32 зняття прав | `revoked admin is refused within a minute` | integration (керований годинник; `backend/tests/admin/test_authz.py` «revoked admin is refused within a minute», `backend/tests/admin/test_nfr.py`, `backend/tests/test_admin_grant.py` на емуляторі) + e2e-through-UI live (`frontend/e2e-live/revoke.spec.ts` «AC-32: a revoked admin is refused within a minute, on every admin read and action of the open pages»: `scripts/admin_grant.py revoke` на емуляторі, «Оновити» відкритої сторінки щосекунди, межа 60 с; далі збереження з іншої відкритої вкладки, пошук і кожен інший адмінський маршрут — відповідь як для невідомої адреси, нічого не застосовано й не записано; після перезавантаження — «Сторінку не знайдено») | Від зняття позначки не пізніше ніж за 60 с кожна адмінська дія й читання відмовлені (реальний час, перевірка щосекунди) | T09, T26 |
| AC-33 журнал перший (дії) | `failed audit write leaves state unchanged for every mutation` | integration | Для кожної дії (скидання квоти, ліміт, обмеження, зняття, видалення, скасування, типові ліміти, перемикач, банер) зламаний запис журналу → стан не змінився | T10, T01 |
| AC-33 | `admin sees «not applied, retry» when audit fails` | component | Повідомлення, що зміну не застосовано і її треба повторити | T28 |
| AC-33b журнал перший (перегляди) | `failed audit write withholds search results and user card` | integration | Пошук і картка при зламаному записі журналу не повертають особистих даних | T10, T17 |
| AC-33b | `admin sees «data unavailable, retry» when view audit fails` | component | Повідомлення про недоступні дані й повтор | T28 |
| AC-34 свіжий вхід | `fresh-login rule is 15 minutes` | unit | 14:59 — свіжий, 15:01 — потрібен повторний вхід | T09 |
| AC-34 | `stale login blocks deletion and pause until re-auth` | integration | Заплановане видалення й пауза не виконані без свіжого входу; після свіжого — виконані й записані в журнал | T09, T22, T23 |
| AC-34 | `admin re-enters password before scheduling deletion` | component (`frontend/src/admin/actions/RestrictionActions.test.tsx`: «explains that a fresh login is needed, keeps the email, and a second try goes through»; `frontend/src/lib/adminApi.test.ts`: «re-logs in on reauth_required…») | Запит пароля; після підтвердження дія виконана | T28, T34 |
| AC-35 ліміт видалень | `deletion cap is 10 per rolling 60 minutes across all admins` | unit | 10 у вікні — 11-те відхилено; після виходу найстарішого з вікна — прийнято | T22 |
| AC-35 | `11th deletion within 60 minutes by any admin is refused and journaled` | integration | Два адміни разом 10 → 11-те відхилено з поясненням; спроба в журналі | T22 |
| AC-36 перебір не-адміном | `non-admin probe limit is 30 per rolling 60 seconds` | unit | 30 у вікні → наступний відхилено; після виходу з вікна — знову обробляється | T09 |
| AC-36 | `over-limit non-admin is refused identically and keeps normal features` | integration | 31-й запит відхилено так само, як попередні (без підказок); бібліотека й аналізи цього користувача працюють; адміни не обмежені | T09 |

## Edge cases / error paths

Кожен error / authorization AC (AC-04, 06, 09, 14, 17, 21, 23b, 25, 30, 31, 32, 33, 33b, 34, 35, 36) має власні рядки вище. Додаткові межі, які випливають зі spec:

- Пошуковий рядок рівно 3 символи → пошук виконується.
- Email з символами розмітки (`x+<b>@example.test`) у пошуку й картці → показаний як текст, пошук працює.
- Адмінський запит без входу взагалі (анонім) → та сама відповідь «не знайдено», що й для не-адміна.
- Запит до адмінки від адміна, чий вхід прострочений (не 15 хв, а сесія) → відмова без даних.
- Персональний ліміт зі всіма трьома полями на межах (1000 / 150 / 4) → зберігається.
- Скасування видалення після того, як 7 днів минули, але прибирання ще не відбулося → відмова, видалення не скасовується, адмінка показує актуальний стан (sad.md §6 «Скасувати видалення», гілка «вікно вже минуло»).
- Скасування видалення для користувача без запланованого видалення → відмова «скасовувати нічого».
- Збій фонового прибирання посеред видалення → наступний запуск доводить до кінця (ідемпотентність, AC-22).
- Документ налаштувань ще не засіяний → сервер діє за початковими значеннями зі змінних середовища (ADR-0005).
- Перемикач змінено двічі за 60 с → чинний останній стан.
- Пауза вимкнена, але сайт ще бачить стару паузу (≤ 5 хв) → користувач бачить пояснення; після оновлення публічного документа — звичайна поведінка.

## Test data

- **Seed strategy:** фабрики з `data-model.md §Test fixtures` — `make_admin`, `make_user`, `make_tracks`, `make_account_state`, `make_job`, `make_stats_day`, `make_audit`, `seed_synthetic_users(10_000)`, набір `HOSTILE_STRINGS`. Лише адреси `example.test` (захист від реальних особистих даних).
- **Integration dependency:** ефемерний емулятор документної БД, піднятий раз на набір; жодного мок-сховища. Fault injection журналу — навмисне зламаний запис у справжньому сховищі.
- **Cleanup boundary:** **per-test** — після кожного тесту сховище очищається повністю (глобальні документи: налаштування, публічний стан, денна статистика, лічильник видалень — теж). Великі набори для NFR (10 000 користувачів; 1 000 × 20 пісень; 1 × 1 000 пісень) — в окремому наборі з сіянням і очищенням **per-suite**.
- **Time:** керований годинник у коді адмінки, воротах прийому й фонових роботах; межі тестуються з обох боків (UTC-північ, 15 хв, 60 с, 60 хв, 7 днів). Числа поширення змін (≤ 60 с, ≤ 5 хв) перевіряються реальним часом.

## NFR validation (load)

- **Огляд адмінки, сервер прогрітий — p95 ≤ 2 с** → 20 послідовних відкриттів огляду в браузері на прогрітому локальному сервері з емулятором і набором 1 000 × 20; assert p95 ≤ 2 с. **Тест:** `frontend/e2e-live/overview-p95.spec.ts` «NFR: the admin overview opens with p95 ≤ 2 s on a warm server (20 openings in the browser)»: після 2 прогрівальних — 20 відкриттів admin.html у нових вкладках адміна, час у самій сторінці від початку навігації до появи підсумків; друкує всі 20 значень і p95. Виміряно 2026-10-08 (macOS, локальний сервер + емулятори, 5 прогонів): p95 76–90 мс, медіана 71–77 мс.
- **Огляд адмінки, сервер спав — p95 ≤ 15 с** → 5 спроб від холодного старту на справжньому хмарному розгортанні після етапу 1; assert p95 ≤ 15 с. Локально не вимірюється. **Скрипт:** `scripts/measure_cold_start.py` (docs/CLOUD.md «Measuring the cold start»): перед кожною спробою 20 хв тиші (сервіс засинає), час першого запиту — `GET /api/health` або з `--admin` `GET /api/admin/overview` (токен адміна лише зі змінних середовища), `--verify-cold` зараховує лише спроби, для яких Cloud Logging показує старт нового екземпляра; друкує кожну спробу й p95, код виходу 1 понад межу. Запускає власник після розгортання; у CI не входить.
- **Пошук користувача — p95 ≤ 1 с при 10 000 користувачів** → 10 000 синтетичних користувачів, серія пошукових запитів різної довжини; assert p95 ≤ 1 с. Локально з емулятором (оптимістична оцінка; фінальне підтвердження — вимір у хмарі).

### NFR без навантаження (перевіряються іншими рівнями)

| NFR (spec §6) | Як перевіряється | Level |
|---|---|---|
| ≤ 200 читань сховища на екран / сторінку списку | Лічильник читань емулятора для кожного адмінського ендпоінта на наборах 1 000 × 20 і 1 × 1 000; assert ≤ 200 | integration (per-suite seed) |
| Набуття чинності змінами ≤ 60 с | AC-16, AC-24, AC-32 + перемикачі й персональні ліміти: зміна → перевірка щосекунди | e2e live, реальний час (`frontend/e2e-live/restriction.spec.ts`, `default-limit.spec.ts`, `revoke.spec.ts`); між екземплярами — integration з керованим годинником (`backend/tests/admin/test_nfr.py`) |
| Банер / перемикачі на сайті ≤ 5 хв | Зміна → новий візит сайту гостем (банер) і користувачем (перемикач YouTube): статус читається раз на візит, тож зміна доходить одразу; відкрита вкладка перечитує не частіше ніж раз на 5 хв | component (`ServiceBanner.test.ts`, керований годинник) + e2e live (`frontend/e2e-live/banner.spec.ts`: секунди від зміни до нового візиту, межа 300 с; `idle-tab.spec.ts`: відкрита вкладка гостя за 30 хв не перечитує статус частіше ніж раз на 5 хв) |
| 0 запитів від вкладки без дій | AC-02 | e2e-through-UI (`frontend/e2e/admin.spec.ts`, керований годинник) + live, 30 хв реального часу (`frontend/e2e-live/idle-tab.spec.ts`, `LIVE_SLOW=1`) |
| 0 запитів до сервера для банера й перемикачів | AC-27, AC-29 | component (`ServiceBanner.test.ts`, `startLink.test.ts`, `serviceStatus.test.ts`) + e2e live (`frontend/e2e-live/banner.spec.ts`: запити браузера й access-лог сервера) |
| Повнота видалення 100 % / 0 залишків | AC-22 + пошук email і об'єктів видаленого користувача, зокрема в індексі пошуку | e2e live (`frontend/e2e-live/purge.spec.ts`: Auth, індекс бібліотеки, файли сервера, об'єкти бакета, пошук, журнал) + integration |
| Журнал ≥ 365 днів, незмінний | Перевірка політики строку зберігання в міграції 02 + AC-11 | integration + contract |
| Історія задач ≥ 90 днів | Перевірка політики строку зберігання в міграції 02 | integration |
| Точність денної статистики (розбіжність 0, завершений день незмінний) | Звірка підсумків з історією задач за ту ж добу UTC, зокрема знеособлених; видалення користувача не змінює заморожений день | integration |
| Availability ≥ 99 % | Операційна метрика `admin_request` за статусом — моніторинг, не тест | — (T26 alerting) |

Виміряно live-набором 2026-10-08 (macOS, один процес сервера, емулятори; повторювано між прогонами): AC-16 — перша відмова через 0,0 с після обмеження (дія адміна одразу оновлює кеш свого процесу); AC-24 — новий ліміт у `GET /api/me` через 0,0 с; AC-32 — відмова відкритій сторінці через 55,2 с після зняття прав (60,2 с від першого запиту сесії, що заповнив 60-секундний кеш дозволів); банер — у новому візиті через 0,7–0,8 с після публікації, зник для нового візиту через 2,2 с після вимкнення (з них 2 с — навмисне очікування в спеку); перемикач YouTube — у новому візиті через 0,7 с; AC-02 — за 30 хв реального часу 0 запитів до сервера (access-лог і обидві вкладки адміна; вкладка гостя — 0 нових читань статусу).

## CI placement

- **On every PR:** unit, contract, component, visual-regression, integration (емулятор; керований годинник, тож без реальних очікувань).
- **On schedule / pre-release:** e2e та e2e-through-UI (браузер + сервер + емулятор), тести поширення змін у реальному часі (≤ 60 с, ≤ 5 хв, 30-хвилинне спостереження за вкладкою), NFR-набір з 10 000 користувачів і лічильником читань, load-сценарії. **Реалізовано:** `.github/workflows/admin-live-e2e.yml` — щоночі (02:30 UTC) `npm run test:e2e:live` з `LIVE_SLOW=1` (live-набір `frontend/e2e-live/`, зокрема p95 огляду); вручну — з / без 30-хвилинного спеку або з `update_snapshots=true` (Linux-еталони банера як артефакт).
- **Once per stage release, cloud:** вимір холодного старту (p95 ≤ 15 с) — `scripts/measure_cold_start.py` після розгортання (власник; не в CI).

## Known gaps

Рядки плану вище, для яких на запланованому рівні ще немає тесту або тест покриває вимогу не повністю (станом на 2026-10-08, після live-набору `frontend/e2e-live/`). Не приховуються і не вважаються покритими.

| Рядок плану | Чого бракує | Найближче покриття |
|---|---|---|
| AC-29 `site banner matches approved baseline` — еталони для Linux (CI) | Знімки залежать від платформи: у репозиторії лише еталони macOS (`banner.spec.ts-snapshots/*-darwin.png`). Linux-еталони з'являються після разового запуску workflow з `update_snapshots=true` (docs/CLOUD.md «Live e2e»); до того нічний прогін падає на порівнянні знімків банера | Той самий спек на macOS; вміст і мова банера перевіряються текстом і на Linux |
| NFR «огляд адмінки, сервер спав — p95 ≤ 15 с» | Вимір лише скриптом `scripts/measure_cold_start.py` на справжньому розгортанні, власником після деплою; у CI не входить, результату ще не записано | Локальний p95 прогрітого сервера (`overview-p95.spec.ts`); «Verified» у docs/CLOUD.md (перша відповідь після сну 9,2 с, 2026-10-05) |
| AC-16 / AC-24 — межа 60 с між екземплярами в реальному часі | Live-набір має один процес сервера (як і продакшн: max instances 1); дія адміна оновлює кеш цього процесу одразу, тож live-спеки вимірюють ≈ 0 с. Шлях «інший екземпляр бачить зміну після спливу кешу» (стан акаунта 60 с, налаштування 30 с) у реальному часі не перевіряється — лише спливання кешу дозволів (AC-32, `revoke.spec.ts`) | `backend/tests/admin/test_nfr.py` «a default limit changed on one instance applies on another within a minute», `backend/tests/test_admission.py` «a restriction takes effect within a minute» (керований годинник) |
| AC-22 — HTTP-вхід фонового прибирання в live-наборі | `POST /api/internal/sweep` приймає лише підписаний Google OIDC-токен планувальника; локально його не отримати, тож `purge.spec.ts` запускає той самий `Sweeper` + `Purger`, що будує сервер, через `backend/scripts/live_e2e.py sweep`, без HTTP-входу й перевірки токена | `backend/tests/admin/test_sweeps.py` «the scheduler token runs the sweep», «a non-scheduler caller gets the unknown-route 404» (integration) |
| AC-02 — справді фонова вкладка | Безголовий Chromium показує кожну вкладку видимою, тож у `idle-tab.spec.ts` фонову вкладку задано значеннями Page Visibility API (`visibilityState`, `hidden`, подія `visibilitychange`) — тим, що бачить код сторінки; тротлінг таймерів фонової вкладки браузером не відтворюється (у сторінки таймерів немає) | `frontend/e2e/admin.spec.ts` (той самий прийом, керований годинник) |
