# Chords Listener API for Cloud Run (docs/CLOUD.md). Build context: backend/.
#
#   scripts/deploy_cloud.sh                                 Cloud Build -> Artifact Registry -> Cloud Run
#   docker build -t chords-api backend                      local build (linux/amd64)
#   docker run --rm -p 8080:8080 -e CHORDS_ALLOWED_HOSTS=localhost chords-api    (local mode, no auth)
#
# Contents: python 3.11 + the uv-locked backend (with the "vocals" extra when pyproject defines it),
# ffmpeg, node (yt-dlp's JS runtime for YouTube); chord models, numba kernels and Demucs weights are
# warmed at build time so a fresh instance answers its first analysis quickly. numba's cache is keyed
# by the CPU, so kernels are compiled for a fixed AVX2 baseline (NUMBA_CPU_NAME=haswell, no extra
# features): the cache built on Cloud Build is then valid on every Cloud Run host.

FROM node:22-bookworm-slim AS node

FROM python:3.11-slim-bookworm

ARG UV_VERSION=0.11.28
# auto: install the optional "vocals" extra when pyproject.toml defines it; 1 / 0 force it on / off
ARG VOCALS=auto

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=/usr/local/bin/python3.11 \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    VIRTUAL_ENV=/app/.venv \
    PATH=/app/.venv/bin:$PATH \
    NUMBA_CACHE_DIR=/app/cache/numba \
    NUMBA_CPU_NAME=haswell \
    NUMBA_CPU_FEATURES="" \
    TORCH_HOME=/app/cache/torch \
    HF_HOME=/app/cache/huggingface \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    CHORDS_DATA_DIR=/data \
    CHORDS_WORK_DIR=/tmp/chords-work \
    PORT=8080

# Runtime system packages: ffmpeg/ffprobe (decoding), libgomp1 (OpenMP for numeric wheels).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg libgomp1 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# node 22 from the official image: the JavaScript runtime yt-dlp uses for YouTube's challenges.
COPY --from=node /usr/local/bin/node /usr/local/bin/node

# Non-root runtime user; it owns only the model caches and the /data mount point.
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --home-dir /tmp --no-create-home --shell /usr/sbin/nologin app \
 && mkdir -p /app/cache /data \
 && chown app:app /app/cache /data

WORKDIR /app

# Python dependencies (madmom is built from git: git + compilers only for this step, then removed).
COPY pyproject.toml uv.lock ./
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends git build-essential; \
    pip install "uv==${UV_VERSION}"; \
    extra=""; \
    if [ "$VOCALS" = "1" ] || { [ "$VOCALS" = "auto" ] && python -c "import sys, tomllib; d = tomllib.load(open('pyproject.toml', 'rb')); sys.exit(0 if 'vocals' in d.get('project', {}).get('optional-dependencies', {}) else 1)"; }; then \
        extra="--extra vocals"; \
    fi; \
    echo "uv sync extras: ${extra:-none}"; \
    uv sync --frozen --no-dev --no-install-project $extra; \
    pip uninstall -y uv; \
    apt-get purge -y --auto-remove git build-essential; \
    rm -rf /var/lib/apt/lists/* /tmp/* /root/.cache

USER 10001:10001

# Weights that don't depend on the app code (Demucs htdemucs, only with the vocals extra): own layer.
COPY scripts/warmup.py ./scripts/warmup.py
RUN python scripts/warmup.py --vocals

# The app, then the warmups: chord models + numba kernels (into NUMBA_CACHE_DIR), the tools yt-dlp
# needs, and the vocal models' smoke test when that feature is installed (a failure there is reported
# but doesn't break the chord service).
COPY app ./app
RUN python scripts/warmup.py --tools --engine \
 && if python -c "import sys; from app.vocals import available; sys.exit(0 if available() else 1)" 2>/dev/null; then \
        python -m app.vocals.warmup || echo "WARNING: vocals warmup failed"; \
    fi \
 && rm -rf /tmp/* /tmp/.cache

# Runtime: never reach out to the model hubs (everything is cached in the image).
ENV HF_HUB_OFFLINE=1

EXPOSE 8080
# Cloud Run mounts the bucket at /data (mount options uid=10001;gid=10001) and sets $PORT.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080} --no-access-log --timeout-keep-alive 65 --timeout-graceful-shutdown 8"]
