# chords-fetch: short YouTube fragments through Cloudflare WARP (docs/CLOUD.md → YouTube clips). Context: backend/.
#
#   scripts/deploy_fetch.sh                                            Cloud Build -> Artifact Registry -> Cloud Run
#   docker build -f backend/fetch.Dockerfile -t chords-fetch backend   local build (linux/amd64)
#
# Contents: python 3.11 + yt-dlp at the version backend/uv.lock locks (tests/test_fetch_image.py keeps them equal),
# fastapi/uvicorn, google-cloud-storage; ffmpeg (cuts the fragment), node (yt-dlp's JS runtime for YouTube),
# wireproxy (WARP as a userspace SOCKS5 proxy). No analysis dependencies: the image stays small and starts fast.

FROM golang:bookworm AS wireproxy
ARG WIREPROXY_VERSION=v1.1.3
# the module may want a newer Go than the image's: let go fetch the toolchain it asks for
ENV GOTOOLCHAIN=auto
RUN CGO_ENABLED=0 go install github.com/windtf/wireproxy/cmd/wireproxy@${WIREPROXY_VERSION}

FROM node:22-bookworm-slim AS node

FROM python:3.11-slim-bookworm

ARG YTDLP_VERSION=2026.8.19

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    FETCH_WORK_DIR=/tmp/chords-fetch \
    PORT=8080

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=wireproxy /go/bin/wireproxy /usr/local/bin/wireproxy

RUN pip install "yt-dlp[default]==${YTDLP_VERSION}" "fastapi==0.142.2" "uvicorn[standard]==0.54.0" \
      "google-cloud-storage==3.16.0" "google-auth==2.59.1"

RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --home-dir /tmp --no-create-home --shell /usr/sbin/nologin app

WORKDIR /app
COPY app/__init__.py app/models.py app/sources.py app/gcs.py app/warp.py app/fetch_service.py ./app/
USER 10001:10001

EXPOSE 8080
# Cloud Run sets $PORT and mounts the WARP profile (Secret Manager) at $WARP_PROFILE.
CMD ["sh", "-c", "exec uvicorn --factory app.fetch_service:create_app_from_env --host 0.0.0.0 --port ${PORT:-8080} --no-access-log --timeout-keep-alive 65"]
