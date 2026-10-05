#!/usr/bin/env bash
# Deploys the Chords Listener API to Cloud Run (docs/CLOUD.md). Idempotent: re-run it to redeploy.
#
#   scripts/deploy_cloud.sh                  everything: setup + Cloud Build + deploy
#   SKIP_SETUP=1 scripts/deploy_cloud.sh     code-only redeploy (no APIs/repo/bucket/IAM/rules/CORS steps)
#   SKIP_BUILD=1 scripts/deploy_cloud.sh     redeploy the newest image (settings / env changes only)
#
# Credentials: a normal `gcloud auth login`, or - without one - an access token minted from the
# firebase-tools login (scripts/gcloud_token.cjs, re-minted every 40 min, kept in a 0600 temp file).
# Secrets: CHORDS_SIGNING_KEY and CHORDS_SMOKE_KEY are generated once into .cloud.env (gitignored,
# mode 600) and reused. Nothing secret is printed.
#
# Cost guards (docs/CLOUD.md): max 1 instance, min 0, 4 vCPU / 16 GiB, CPU always allocated while an
# instance is up, 1 h request timeout, the 3 newest images kept in Artifact Registry.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${PROJECT:-build-chords-listener}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-chords-api}"
REPO="${REPO:-chords}"
BUCKET="${BUCKET:-$PROJECT.firebasestorage.app}"
IMAGE="$REGION-docker.pkg.dev/$PROJECT/$REPO/api"
RUNTIME_SA_NAME="${RUNTIME_SA_NAME:-chords-api}"
RUNTIME_SA="$RUNTIME_SA_NAME@$PROJECT.iam.gserviceaccount.com"
ENV_FILE="${CLOUD_ENV_FILE:-$ROOT/.cloud.env}"
APP_UID=10001 # the image's non-root user (backend/Dockerfile)
FIREBASE_CMD="${FIREBASE_CMD:-npx -y firebase-tools@latest}"

GCLOUD="${GCLOUD:-$(command -v gcloud || true)}"
[[ -x "$GCLOUD" ]] || GCLOUD=/opt/homebrew/share/google-cloud-sdk/bin/gcloud
[[ -x "$GCLOUD" ]] || { echo "gcloud not found (set GCLOUD=/path/to/gcloud)" >&2; exit 1; }
for tool in node curl openssl python3; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/chords-deploy.XXXXXX")"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
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

log "Project $PROJECT, region $REGION, service $SERVICE (auth: $AUTH_MODE)"

if [[ -z "${SKIP_SETUP:-}" ]]; then
  # ---------------------------------------------------------------------------- APIs
  log "Enabling APIs"
  gc services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
    storage.googleapis.com firebasestorage.googleapis.com firebaserules.googleapis.com \
    firestore.googleapis.com iam.googleapis.com iamcredentials.googleapis.com logging.googleapis.com

  # ---------------------------------------------------------------------------- Artifact Registry
  log "Artifact Registry repository $REPO"
  if ! gc artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1; then
    gc artifacts repositories create "$REPO" --repository-format=docker --location "$REGION" \
      --description="Chords Listener API images"
  fi
  cat > "$TMP/cleanup.json" <<'JSON'
[
  {"name": "keep-3-newest", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 3}},
  {"name": "delete-older", "action": {"type": "Delete"}, "condition": {"tagState": "any", "olderThan": "3d"}}
]
JSON
  gc artifacts repositories set-cleanup-policies "$REPO" --location "$REGION" \
    --policy="$TMP/cleanup.json" --no-dry-run >/dev/null

  # ---------------------------------------------------------------------------- Firebase Storage bucket
  log "Firebase Storage default bucket $BUCKET"
  api GET "https://firebasestorage.googleapis.com/v1alpha/projects/$PROJECT/defaultBucket"
  if [[ "$API_STATUS" == 404 ]]; then
    echo "creating it in $REGION"
    api POST "https://firebasestorage.googleapis.com/v1alpha/projects/$PROJECT/defaultBucket" "{\"location\": \"$REGION\"}"
    if [[ "$API_STATUS" != 200 ]]; then
      echo "defaultBucket.create failed ($API_STATUS):" >&2; cat "$TMP/api.out" >&2; exit 1
    fi
  elif [[ "$API_STATUS" != 200 ]]; then
    echo "defaultBucket.get failed ($API_STATUS):" >&2; cat "$TMP/api.out" >&2; exit 1
  fi
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('default bucket:', d.get('name'), d.get('location') or '')" "$TMP/api.out"
  # make sure Firebase has it linked (no-op when it already is)
  api GET "https://firebasestorage.googleapis.com/v1beta/projects/$PROJECT/buckets/$BUCKET"
  if [[ "$API_STATUS" == 404 ]]; then
    api POST "https://firebasestorage.googleapis.com/v1beta/projects/$PROJECT/buckets/$BUCKET:addFirebase" '{}'
    [[ "$API_STATUS" == 200 ]] || { echo "linking the bucket failed ($API_STATUS)" >&2; cat "$TMP/api.out" >&2; exit 1; }
  fi
  gc storage buckets describe "gs://$BUCKET" --format='value(name,location,storage_class)'

  # ---------------------------------------------------------------------------- runtime service account
  log "Runtime service account $RUNTIME_SA"
  if ! gc iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1; then
    gc iam service-accounts create "$RUNTIME_SA_NAME" --display-name="Chords Listener API (Cloud Run)"
  fi
  for attempt in 1 2 3 4 5 6; do # a new service account takes a moment to become usable in IAM
    if gc storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$RUNTIME_SA" \
        --role=roles/storage.objectUser >/dev/null 2>"$TMP/iam.err"; then
      echo "roles/storage.objectUser on gs://$BUCKET"; break
    fi
    [[ $attempt == 6 ]] && { cat "$TMP/iam.err" >&2; exit 1; }
    sleep 10
  done
  # the API writes the library index (users/{uid}/tracks) to Firestore over REST
  if ! gc projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUNTIME_SA" \
      --role=roles/datastore.user --condition=None >/dev/null 2>"$TMP/iam.err"; then
    cat "$TMP/iam.err" >&2; exit 1
  fi
  echo "roles/datastore.user on project $PROJECT"

  # ---------------------------------------------------------------------------- security rules, bucket CORS
  log "Storage + Firestore security rules (storage.rules, firestore.rules)"
  (cd "$ROOT" && $FIREBASE_CMD deploy --only storage,firestore:rules --project "$PROJECT" --non-interactive)

  # the site streams the published audio / stems straight from the bucket (token URLs, HTTP Range)
  log "Bucket CORS gs://$BUCKET (storage-cors.json)"
  gc storage buckets update "gs://$BUCKET" --cors-file="$ROOT/storage-cors.json"
fi

# ------------------------------------------------------------------------------ secrets
if [[ ! -s "$ENV_FILE" ]]; then
  log "Generating secrets into $ENV_FILE"
  (
    umask 077
    {
      echo "# Chords Listener cloud secrets, generated by scripts/deploy_cloud.sh and reused on redeploys."
      echo "# Never commit this file (it is in .gitignore)."
      echo "CHORDS_SIGNING_KEY=$(openssl rand -hex 32)"
      echo "CHORDS_SMOKE_KEY=$(openssl rand -hex 24)"
    } > "$ENV_FILE"
  )
fi
chmod 600 "$ENV_FILE"
secret() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
SIGNING_KEY="$(secret CHORDS_SIGNING_KEY)"
SMOKE_KEY="$(secret CHORDS_SMOKE_KEY)"
[[ -n "$SIGNING_KEY" && -n "$SMOKE_KEY" ]] || { echo "$ENV_FILE lacks CHORDS_SIGNING_KEY / CHORDS_SMOKE_KEY" >&2; exit 1; }

# ------------------------------------------------------------------------------ build
if [[ -z "${SKIP_BUILD:-}" ]]; then
  TAG="${IMAGE_TAG:-$(date -u +%Y%m%d-%H%M%S)}"
  log "Cloud Build: $IMAGE:$TAG"
  BUILD_ID=$(gc builds submit "$ROOT/backend" --config "$ROOT/backend/cloudbuild.yaml" \
    --substitutions "_IMAGE=$IMAGE,_TAG=$TAG" --async --format='value(id)')
  echo "build $BUILD_ID: https://console.cloud.google.com/cloud-build/builds/$BUILD_ID?project=$PROJECT"
  while true; do
    STATUS=$(gc builds describe "$BUILD_ID" --format='value(status)')
    case "$STATUS" in
      SUCCESS) break ;;
      FAILURE|INTERNAL_ERROR|TIMEOUT|CANCELLED|EXPIRED)
        echo "build $STATUS - last log lines:" >&2
        gc logging read "resource.type=build AND resource.labels.build_id=$BUILD_ID" --limit 80 \
          --format='value(textPayload)' --order=desc 2>/dev/null \
          | awk '{ line[NR] = $0 } END { for (i = NR; i > 0; i--) print line[i] }' >&2 || true
        exit 1 ;;
    esac
    printf '  %s (%s)\n' "$STATUS" "$(elapsed)"
    sleep 20
  done
  echo "build finished ($(elapsed))"
  # the uploaded source archive is no longer needed
  SRC=$(gc builds describe "$BUILD_ID" --format='value(source.storageSource.bucket,source.storageSource.object)' | tr '\t' '/')
  [[ -n "$SRC" && "$SRC" != "/" ]] && gc storage rm "gs://$SRC" >/dev/null 2>&1 || true
  DEPLOY_IMAGE="$IMAGE:$TAG"
else
  DEPLOY_IMAGE="$IMAGE:latest"
fi

# ------------------------------------------------------------------------------ deploy
log "Deploying $SERVICE ($DEPLOY_IMAGE)"
(
  umask 077
  cat > "$TMP/env.yaml" <<EOF
CHORDS_AUTH: firebase
CHORDS_FIREBASE_PROJECT: "$PROJECT"
CHORDS_DATA_DIR: /data
CHORDS_WORK_DIR: /tmp/chords-work
CHORDS_UPLOAD_BUCKET: "$BUCKET"
CHORDS_PUBLISH: "1"
CHORDS_SIGNING_KEY: "$SIGNING_KEY"
CHORDS_SMOKE_KEY: "$SMOKE_KEY"
CHORDS_QUOTA_ANALYSES: "${CHORDS_QUOTA_ANALYSES:-40}"
CHORDS_QUOTA_VOCALS: "${CHORDS_QUOTA_VOCALS:-15}"
CHORDS_QUOTA_JOBS: "${CHORDS_QUOTA_JOBS:-2}"
CHORDS_MAX_WORKERS: "2"
EOF
)
gc run deploy "$SERVICE" \
  --image "$DEPLOY_IMAGE" \
  --region "$REGION" \
  --execution-environment gen2 \
  --cpu 4 --memory 16Gi \
  --no-cpu-throttling \
  --cpu-boost \
  --timeout 3600 \
  --concurrency 16 \
  --min-instances 0 \
  --max-instances 1 \
  --port 8080 \
  --allow-unauthenticated \
  --service-account "$RUNTIME_SA" \
  --env-vars-file "$TMP/env.yaml" \
  --clear-volumes --clear-volume-mounts \
  --add-volume "name=data,type=cloud-storage,bucket=$BUCKET,mount-options=uid=$APP_UID;gid=$APP_UID" \
  --add-volume-mount "volume=data,mount-path=/data" \
  --quiet

URL=$(gc run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
NUMBER=$(gc projects describe "$PROJECT" --format='value(projectNumber)')
log "Done in $(elapsed)"
echo "Service URL:      $URL"
echo "Stable URL:       https://$SERVICE-$NUMBER.$REGION.run.app"
echo "Health:           $(curl -fsS --max-time 120 "$URL/api/health" || echo 'not answering yet')"
