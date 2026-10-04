#!/usr/bin/env bash
# Chords Listener — development mode.
#
#   ./dev.sh   backend (uvicorn --reload) on 127.0.0.1:8765 + Vite dev server with HMR on
#              http://localhost:5173 (proxies /api to the backend). Ctrl+C stops both.
#
# Environment:
#   CHORDS_PORT=8765       backend port
#   CHORDS_DEV_PORT=5173   Vite port (the backend's CORS list only matters for 5173; through the
#                          Vite proxy every port works)
#
# Works with the stock macOS bash 3.2.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_PORT="${CHORDS_PORT:-8765}"
UI_PORT="${CHORDS_DEV_PORT:-5173}"

for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/.cargo/bin"; do
  case ":$PATH:" in *":$dir:"*) ;; *) [ -d "$dir" ] && PATH="$PATH:$dir" ;; esac
done
export PATH

for tool in uv node npm ffmpeg; do
  command -v "$tool" >/dev/null 2>&1 || { echo "✗ '$tool' не знайдено — див. README.md (Вимоги) або запусти ./start.sh для підказок." >&2; exit 1; }
done
for port in "$API_PORT" "$UI_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "✗ Порт $port уже зайнятий (lsof -nP -iTCP:$port -sTCP:LISTEN)." >&2
    echo "  Інші порти:  CHORDS_PORT=8766 CHORDS_DEV_PORT=5174 ./dev.sh" >&2
    exit 1
  fi
done

(cd "$ROOT/backend" && uv sync --quiet)
[ -d "$ROOT/frontend/node_modules" ] || (cd "$ROOT/frontend" && npm install --no-audit --no-fund --loglevel=error)

# Job control: each server gets its own process group, so cleanup can stop it together with its
# children (uvicorn's reloader worker, Vite's esbuild). stdin is detached: a background process
# group that reads the terminal (Vite's key shortcuts) would be stopped by SIGTTIN.
set -m
pids=""
cleanup() {
  trap - INT TERM EXIT
  echo
  echo "Зупиняю…"
  for pid in $pids; do kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; done
  for pid in $pids; do wait "$pid" 2>/dev/null || true; done
}
trap cleanup INT TERM EXIT

(cd "$ROOT/backend" && exec uv run --no-sync uvicorn app.main:app --host 127.0.0.1 --port "$API_PORT" --reload --reload-dir app) </dev/null &
pids="$pids $!"
(cd "$ROOT/frontend" && exec env CHORDS_BACKEND_URL="http://127.0.0.1:$API_PORT" npx --no-install vite --port "$UI_PORT" --strictPort) </dev/null &
pids="$pids $!"

echo
echo "  API:  http://127.0.0.1:$API_PORT/api/docs"
echo "  UI:   http://localhost:$UI_PORT   (Ctrl+C — зупинити обидва)"
echo

# bash 3.2 has no `wait -n`: poll until either server exits, then stop the other one.
while true; do
  for pid in $pids; do
    kill -0 "$pid" 2>/dev/null || exit 0
  done
  sleep 1
done
