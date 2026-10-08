---
status: Accepted
owner: "Тарас Щадило (Tech Lead)"
reviewers: ["Tech Lead", "Security Lead"]
updated_at: "2026-10-07"
feature_size: "L"
ticket: "docs/features/admin/spec.md"
---

# 0002 — Ship the admin UI as a separate admin.html entry with a strict CSP

- **Status:** Accepted
- **Date:** 2026-10-07
- **Deciders:** Тарас Щадило (Tech Lead) + Claude під час Socratic-проходу `design`

## Context

Найгостріший ризик зі spec §6.1 — stored XSS: шкідливий текст у назві пісні, джерелі, тексті помилки чи email виконується в браузері Адміністратора. Сайт хоститься на GitHub Pages, тож CSP можлива лише через `<meta http-equiv>` і діє на всю сторінку; основний сайт використовує TensorFlow.js, WebAssembly і вбудований плеєр YouTube, яким сувора CSP заважає.

## Decision drivers

- Ціль якості №1 (§1) — безпека межі адміністратора; spec §6.1 «адмінка забороняє виконання вбудованих скриптів».
- AC-05 — назва показується дослівно, нічого з неї не виконується.
- §2 — GitHub Pages без HTTP-заголовків.
- Перевикористання існуючих компонентів, Tailwind-токенів, i18n і Firebase Auth (не будуємо дизайн-систему наново).

## Considered options

1. **Окремий `admin.html` у тій самій Vite-збірці** — multi-page build: власний React-корінь, спільні компоненти/токени/i18n/auth, без TF.js і плеєра, сувора CSP у `<meta>`.
2. **Маршрут `#/admin` в існуючому SPA** — lazy chunk у тому самому `index.html`; CSP або м'яка (винятки для TF.js/YouTube/wasm), або відсутня.

## Decision outcome

**Chosen:** Option 1. Сувора CSP (`script-src 'self'`, без inline і eval, `connect-src` лише до API сервера й Firebase Auth, `frame-src 'none'`, `object-src 'none'`) дає другу лінію захисту від XSS, не ламаючи основний сайт; бандл адмінки легкий.

### Amendments (T46, review 2026-10-08)

- **`connect-src` hosts** (pinned by `frontend/src/admin/adminEntry.test.ts`): `'self'`, the cloud API `chords-api-84488579848.europe-west1.run.app`, and the Firebase Auth hosts `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`, `www.googleapis.com` (token and provider calls of the Auth SDK). `firestore.googleapis.com` is **not** allowed: the admin reads everything through the API, and `src/admin/main.tsx` starts auth with `startAuth({ settingsSync: false })`, so the page opens no Firestore listener (the browser e2e asserts no CSP violation at all).
- **Framing:** a `<meta>` CSP ignores `frame-ancestors`, so `src/admin/main.tsx` runs a frame guard first (`frameGuard.ts`): a framed page navigates the top window to itself and renders nothing.
- **Language:** the admin page is pinned to Ukrainian (`<html lang="uk">`, `useDocumentTheme(ADMIN_LANG)`, admin error texts and `useAdminT` always `uk`), regardless of the site language; the admin is the owner, so the screens are not translated.

## Consequences

**Positive**
- Навіть пропущена розмітка не виконується браузером.
- Адмінка вантажиться без моделей і плеєра.
- Основний сайт не змінюється.

**Negative**
- Друга точка входу у `vite.config` і в CI; адреса `/chords-listener/admin.html#/…`.
- Спільні модулі не мають тягнути TF.js у бандл адмінки — потрібна перевірка розміру/вмісту бандла в CI.
- Inline-стилі/скрипти, які додає Vite у dev-режимі, можуть вимагати окремої dev-CSP.

**Neutral**
- Код адмінки публічний (як і весь сайт) — безпека тримається на сервері (ADR-0006), CSP — лише друга лінія.

## Links

- Spec: [[../spec.md]]
- SAD: [[../sad.md]] §4, §5, §8
- Related ADR: [[0001-build-admin-as-backend-service-and-web-frontend]]
