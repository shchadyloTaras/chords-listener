# Chords Listener — web UI

Vite + React 19 + TypeScript + Tailwind v4 + zustand. See the project [README](../README.md) (Ukrainian) for
running the app and [docs/SPEC.md](../docs/SPEC.md) for the API / store / i18n contracts and file ownership.

```bash
npm run dev      # http://localhost:5173, proxies /api → 127.0.0.1:8765 (or use ../dev.sh)
npm run build    # tsc -b && vite build → dist/ (served by the backend at http://localhost:8765)
npm test         # vitest (music, diagrams, handpan, tempo, browser engine, local library, API routing)
npm run lint     # oxlint
```

`playground.html` + `src/dev/Playground.tsx` mount the chord workspace with a fake player and a stress
track (`npx vite` → `/playground.html`); they are not part of the production build.
