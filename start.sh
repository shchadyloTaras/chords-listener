#!/usr/bin/env bash
# Chords Listener — one-command start.
#
#   ./start.sh            install what's missing, build the UI if needed, start the server
#                         on http://localhost:8765 and open it in the browser. Ctrl+C stops it.
#
# Environment:
#   CHORDS_PORT=8765      port to use
#   CHORDS_NO_OPEN=1      don't open the browser
#   CHORDS_DATA_DIR=...   where analyzed songs are stored (default: ./data)
#
# Works with the stock macOS bash 3.2 (no bash-4 features).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
PORT="${CHORDS_PORT:-8765}"
URL="http://localhost:$PORT"

# Homebrew tools are not always on PATH (e.g. when started from an IDE or Finder).
for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/.cargo/bin"; do
  case ":$PATH:" in *":$dir:"*) ;; *) [ -d "$dir" ] && PATH="$PATH:$dir" ;; esac
done
export PATH

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi
step() { printf '%s▸ %s%s\n' "$BOLD" "$1" "$RESET"; }
ok() { printf '  %s✓ %s%s\n' "$GREEN" "$1" "$RESET"; }
warn() { printf '  %s! %s%s\n' "$YELLOW" "$1" "$RESET"; }
die() {
  printf '\n%s✗ %s%s\n' "$RED" "$1" "$RESET" >&2
  shift
  for line in "$@"; do printf '    %s\n' "$line" >&2; done
  exit 1
}

# ------------------------------------------------------------------ requirements
step "Перевіряю інструменти (check tools)"

command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1 ||
  die "Не знайдено ffmpeg / ffprobe (needed to decode audio and video)." \
    "Встанови:  brew install ffmpeg"
ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"

command -v uv >/dev/null 2>&1 ||
  die "Не знайдено uv (Python package manager)." \
    "Встанови:  brew install uv" \
    "або:       curl -LsSf https://astral.sh/uv/install.sh | sh"
ok "uv $(uv --version 2>/dev/null | awk '{print $2}')"

command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 ||
  die "Не знайдено Node.js (needed to build the web UI)." \
    "Встанови:  brew install node@22   (потрібна версія 20.19+ або 22.12+)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 20 ] ||
  die "Node.js $(node --version) застарий — потрібна версія 20.19+ або 22.12+." \
    "Онови:  brew install node@22"
ok "node $(node --version)"

command -v git >/dev/null 2>&1 ||
  warn "git не знайдено — він потрібен лише при першому встановленні (madmom ставиться з GitHub). Встанови: xcode-select --install"

# ------------------------------------------------------------------ port
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"engine"'; then
    printf '\n%sChords Listener вже запущено:%s %s\n' "$GREEN" "$RESET" "$URL"
    [ "${CHORDS_NO_OPEN:-}" = "1" ] || { command -v open >/dev/null 2>&1 && open "$URL"; } || true
    exit 0
  fi
  die "Порт $PORT зайнятий іншою програмою." \
    "Подивитись хто:  lsof -nP -iTCP:$PORT -sTCP:LISTEN" \
    "Або запусти на іншому порту:  CHORDS_PORT=8766 ./start.sh"
fi

# ------------------------------------------------------------------ backend deps
step "Python-залежності (uv sync)"
(cd "$BACKEND" && uv sync --quiet) ||
  die "uv sync не вдався." \
    "Перша установка збирає madmom з GitHub: потрібні git та Xcode Command Line Tools (xcode-select --install)." \
    "Спробуй ще раз з подробицями:  cd backend && uv sync"
ok "backend/.venv готовий"

# ------------------------------------------------------------------ frontend
step "Веб-інтерфейс"
if [ ! -d "$FRONTEND/node_modules" ] || [ "$FRONTEND/package-lock.json" -nt "$FRONTEND/node_modules/.package-lock.json" ]; then
  echo "  npm install…"
  (cd "$FRONTEND" && npm install --no-audit --no-fund --loglevel=error) ||
    die "npm install не вдався." "Спробуй вручну:  cd frontend && npm install"
fi

needs_build=0
if [ ! -f "$FRONTEND/dist/index.html" ]; then
  needs_build=1
elif [ -n "$(find "$FRONTEND/src" "$FRONTEND/public" "$FRONTEND/index.html" "$FRONTEND/vite.config.ts" \
  "$FRONTEND/package.json" "$FRONTEND/tsconfig.app.json" -newer "$FRONTEND/dist/index.html" -print -quit 2>/dev/null)" ]; then
  needs_build=1
fi
if [ "$needs_build" = "1" ]; then
  echo "  збираю (vite build)…"
  (cd "$FRONTEND" && npx --no-install vite build --logLevel error) ||
    die "Збірка інтерфейсу не вдалась." "Подробиці:  cd frontend && npm run build"
  ok "зібрано у frontend/dist"
else
  ok "frontend/dist актуальний"
fi

# ------------------------------------------------------------------ run
printf '\n%sChords Listener%s → %s%s%s   %s(Ctrl+C — зупинити)%s\n\n' "$BOLD" "$RESET" "$BOLD" "$URL" "$RESET" "$DIM" "$RESET"

# Open the browser once the API answers. The helper stops on its own when the server exits.
MAIN_PID=$$
(
  for _ in $(seq 1 240); do
    kill -0 "$MAIN_PID" 2>/dev/null || exit 0
    if curl -fsS --max-time 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      [ "${CHORDS_NO_OPEN:-}" = "1" ] && exit 0
      if command -v open >/dev/null 2>&1; then open "$URL"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1; fi
      exit 0
    fi
    sleep 0.5
  done
) &

# exec: uvicorn becomes this process, so Ctrl+C reaches it directly and it shuts down cleanly
# (running jobs are cancelled, temporary work files removed).
cd "$BACKEND"
exec uv run --no-sync uvicorn app.main:app --host 127.0.0.1 --port "$PORT" --log-level warning
