# Shared by scripts/deploy_cloud.sh and scripts/deploy_fetch.sh (sourced, not run). Expects ROOT, PROJECT, REGION
# and TMP (a private 0700 temp dir) to be set. Provides $GCLOUD, log, elapsed, refresh_token, gc (gcloud with a
# fresh token), api (a REST call with the token) and cloud_build (Cloud Build in $REGION, waits, cleans up).
#
# Credentials: a normal `gcloud auth login`, or - without one - an access token minted from the firebase-tools
# login (scripts/gcloud_token.cjs, re-minted every 40 min, kept in a 0600 file in $TMP). Nothing secret is printed.

GCLOUD="${GCLOUD:-$(command -v gcloud || true)}"
[[ -x "$GCLOUD" ]] || GCLOUD=/opt/homebrew/share/google-cloud-sdk/bin/gcloud
[[ -x "$GCLOUD" ]] || { echo "gcloud not found (set GCLOUD=/path/to/gcloud)" >&2; exit 1; }
export CLOUDSDK_CORE_PROJECT="$PROJECT" CLOUDSDK_CORE_DISABLE_PROMPTS=1

STARTED=$(date +%s)
log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
elapsed() { echo "$(( $(date +%s) - STARTED ))s"; }

# ------------------------------------------------------------------------------ credentials
TOKEN_FILE="$TMP/token"
TOKEN_AT=0
if [[ -n "${CLOUDSDK_AUTH_ACCESS_TOKEN_FILE:-}" ]]; then
  AUTH_MODE=file # the caller manages the token
  cp "$CLOUDSDK_AUTH_ACCESS_TOKEN_FILE" "$TOKEN_FILE"
elif "$GCLOUD" auth print-access-token >/dev/null 2>&1; then
  AUTH_MODE=gcloud
else
  AUTH_MODE=mint
fi

refresh_token() { # keeps $TOKEN_FILE fresh (tokens live ~60 min)
  local now
  now=$(date +%s)
  if (( now - TOKEN_AT < 2400 )); then return; fi
  case "$AUTH_MODE" in
    mint)
      node "$ROOT/scripts/gcloud_token.cjs" "$TOKEN_FILE" >/dev/null
      export CLOUDSDK_AUTH_ACCESS_TOKEN_FILE="$TOKEN_FILE" ;;
    gcloud)
      (umask 077; "$GCLOUD" auth print-access-token > "$TOKEN_FILE") ;;
    file)
      cp "$CLOUDSDK_AUTH_ACCESS_TOKEN_FILE" "$TOKEN_FILE" ;;
  esac
  TOKEN_AT=$now
}
refresh_token
gc() { refresh_token; "$GCLOUD" "$@"; }

# REST call with the access token (header read from a 0600 file, never on a command line).
# Usage: api METHOD URL [JSON]; sets API_STATUS, body in $TMP/api.out
api() {
  refresh_token
  (umask 077; printf 'Authorization: Bearer %s\nx-goog-user-project: %s\n' "$(cat "$TOKEN_FILE")" "$PROJECT" > "$TMP/auth.hdr")
  local data=()
  if [[ $# -ge 3 ]]; then data=(-H 'Content-Type: application/json' --data "$3"); fi
  API_STATUS=$(curl -sS -o "$TMP/api.out" -w '%{http_code}' -X "$1" -H @"$TMP/auth.hdr" ${data[@]+"${data[@]}"} "$2")
  rm -f "$TMP/auth.hdr"
}

# ------------------------------------------------------------------------------ Cloud Build
# Builds backend/ with CONFIG into IMAGE:TAG in $REGION (the repository's region: the cache pull of the previous
# image stays inside it), waits, prints the log tail on failure, deletes the uploaded source archive.
# Usage: cloud_build CONFIG IMAGE TAG
cloud_build() {
  local config=$1 image=$2 tag=$3 build_id status src
  build_id=$(gc builds submit "$ROOT/backend" --config "$config" --region "$REGION" \
    --substitutions "_IMAGE=$image,_TAG=$tag" --async --format='value(id)')
  echo "build $build_id: https://console.cloud.google.com/cloud-build/builds;region=$REGION/$build_id?project=$PROJECT"
  while true; do
    status=$(gc builds describe "$build_id" --region "$REGION" --format='value(status)')
    case "$status" in
      SUCCESS) break ;;
      FAILURE|INTERNAL_ERROR|TIMEOUT|CANCELLED|EXPIRED)
        echo "build $status - last log lines:" >&2
        gc logging read "resource.type=build AND resource.labels.build_id=$build_id" --limit 80 \
          --format='value(textPayload)' --order=desc 2>/dev/null \
          | awk '{ line[NR] = $0 } END { for (i = NR; i > 0; i--) print line[i] }' >&2 || true
        exit 1 ;;
    esac
    printf '  %s (%s)\n' "$status" "$(elapsed)"
    sleep 20
  done
  echo "build finished ($(elapsed))"
  src=$(gc builds describe "$build_id" --region "$REGION" \
    --format='value(source.storageSource.bucket,source.storageSource.object)' | tr '\t' '/')
  if [[ -n "$src" && "$src" != "/" ]]; then gc storage rm "gs://$src" >/dev/null 2>&1 || true; fi
}
