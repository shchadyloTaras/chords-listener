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
#
# Admin console ops (docs/features/admin, T26), after the deploy (SKIP_OPS=1 skips them):
#   - max-instances guard: the admin's quotas and limits live in process memory, so MAX_INSTANCES must be 1.
#     The script refuses anything else before it touches Google Cloud and checks the deployed value afterwards.
#   - two Cloud Scheduler jobs (00:15 and 12:15 UTC) call POST /api/internal/sweep with an OIDC token of the
#     service account chords-scheduler@ (the server checks signature, audience and that email).
#   - log-based metrics (admin_request, server_wake_by, deletion_overdue, stats_mismatch, audit_write_failed) and
#     alert policies on deletion_overdue > 0 and stats_mismatch > 0, e-mailed to ALERT_EMAIL (env or .cloud.env).
#   DRY_RUN=1 scripts/deploy_cloud.sh   prints the guard and these commands without calling Google Cloud.
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
SCHEDULER_SA_NAME="${SCHEDULER_SA_NAME:-chords-scheduler}"
SCHEDULER_SA="$SCHEDULER_SA_NAME@$PROJECT.iam.gserviceaccount.com"
SWEEP_PATH="/api/internal/sweep"
SWEEP_JOBS=("chords-sweep-0015|15 0 * * *" "chords-sweep-1215|15 12 * * *") # name|cron, UTC (sad §7)
ALERT_CHANNEL_NAME="chords-owner-email"

# ------------------------------------------------------------------------------ max-instances guard
# The admin's daily quota, probe limiter and deletion limit are counted in the memory of the one process (sad §11,
# ADR-0003): a second instance would double them. Checked first, before anything is created or changed.
MAX_INSTANCES="${MAX_INSTANCES-1}"
if [[ "$MAX_INSTANCES" != "1" ]]; then
  echo "refusing to deploy: max-instances must be 1 (got '$MAX_INSTANCES'); the admin's in-memory quotas and limits" \
       "are only correct with a single instance (sad §11)" >&2
  exit 1
fi

# ------------------------------------------------------------------------------ ops (scheduler, metrics, alerts)
# One definition of the commands, used by the real run and by DRY_RUN=1 (where `gc` / `api` only print).
shell_quote() { # single-quote what a shell would split or expand, so a printed command can be pasted
  local a
  for a in "$@"; do
    case "$a" in *[!A-Za-z0-9_./:=@,+%-]*|"") printf " '%s'" "$a" ;; *) printf " %s" "$a" ;; esac
  done
}

ops_dry() { [[ -n "${DRY_RUN:-}" ]]; }

ops_sweep_scheduler() { # $1 = the service's stable URL (the OIDC audience)
  local url="$1" entry name cron verb
  echo "scheduler service account $SCHEDULER_SA"
  if ops_dry || ! gc iam service-accounts describe "$SCHEDULER_SA" >/dev/null 2>&1; then
    gc iam service-accounts create "$SCHEDULER_SA_NAME" --display-name="Chords Listener sweep (Cloud Scheduler)"
  fi
  gc run services add-iam-policy-binding "$SERVICE" --region "$REGION" \
    --member="serviceAccount:$SCHEDULER_SA" --role=roles/run.invoker --format=none
  for entry in "${SWEEP_JOBS[@]}"; do
    name="${entry%%|*}"
    cron="${entry#*|}"
    verb=create
    if ! ops_dry && gc scheduler jobs describe "$name" --location "$REGION" >/dev/null 2>&1; then verb=update; fi
    gc scheduler jobs "$verb" http "$name" --location "$REGION" \
      --schedule "$cron" --time-zone UTC \
      --uri "$url$SWEEP_PATH" --http-method POST \
      --oidc-service-account-email "$SCHEDULER_SA" --oidc-token-audience "$url" \
      --attempt-deadline 15m --max-retry-attempts 3 --min-backoff 1m --max-backoff 30m
  done
}

# name|filter: counters over the log lines the server writes (textPayload, see backend/app/admin/*.py)
LOG_METRICS=(
  'admin_request|textPayload:"admin_request route="'
  'server_wake_by|textPayload:"server_wake_by by="'
  'deletion_overdue|textPayload=~"deletion_overdue count=[1-9]"'
  'stats_mismatch|textPayload:"stats_mismatch day="'
  'audit_write_failed|textPayload:"audit_write_failed action="'
)

ops_log_metrics() {
  local entry name filter verb base
  base="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\""
  for entry in "${LOG_METRICS[@]}"; do
    name="${entry%%|*}"
    filter="$base AND ${entry#*|}"
    verb=create
    if ! ops_dry && gc logging metrics describe "$name" >/dev/null 2>&1; then verb=update; fi
    gc logging metrics "$verb" "$name" --description "Chords Listener admin: $name log lines" --log-filter "$filter"
  done
}

ops_alert_policy() { # $1 = metric, $2 = notification channel resource name
  local metric="$1" channel="$2" file existing=""
  file="$TMP/policy-$metric.json"
  cat > "$file" <<EOF
{
  "displayName": "chords-api: $metric > 0",
  "combiner": "OR",
  "conditions": [{
    "displayName": "$metric > 0",
    "conditionThreshold": {
      "filter": "metric.type=\"logging.googleapis.com/user/$metric\" AND resource.type=\"cloud_run_revision\"",
      "comparison": "COMPARISON_GT",
      "thresholdValue": 0,
      "duration": "0s",
      "aggregations": [{"alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_SUM"}],
      "trigger": {"count": 1}
    }
  }],
  "notificationChannels": ["$channel"],
  "alertStrategy": {"autoClose": "86400s"},
  "documentation": {"mimeType": "text/markdown", "content": "Admin console: $metric (docs/features/admin sad §7 Monitoring)."}
}
EOF
  if ops_dry; then
    cat "$file"
  else
    existing=$(gc monitoring policies list --filter="displayName=\"chords-api: $metric > 0\"" --format='value(name)' | head -1)
  fi
  if [[ -n "$existing" ]]; then
    gc monitoring policies update "$existing" --policy-from-file="$file"
  else
    gc monitoring policies create --policy-from-file="$file"
  fi
}

ops_alerts() {
  local channel
  if [[ -z "${ALERT_EMAIL:-}" ]]; then
    echo "WARNING: ALERT_EMAIL is not set (environment or $ENV_FILE): the alert policies deletion_overdue and" \
         "stats_mismatch were NOT created" >&2
    return 0
  fi
  local body="{\"type\": \"email\", \"displayName\": \"$ALERT_CHANNEL_NAME\", \"labels\": {\"email_address\": \"$ALERT_EMAIL\"}}"
  if ops_dry; then
    channel="projects/$PROJECT/notificationChannels/<$ALERT_CHANNEL_NAME>"
    api POST "https://monitoring.googleapis.com/v3/projects/$PROJECT/notificationChannels" "$body"
  else
    api GET "https://monitoring.googleapis.com/v3/projects/$PROJECT/notificationChannels?filter=displayName%3D%22$ALERT_CHANNEL_NAME%22"
    channel=$(python3 -c "import json,sys; c=json.load(open(sys.argv[1])).get('notificationChannels') or []; print(c[0]['name'] if c else '')" "$TMP/api.out")
    if [[ -z "$channel" ]]; then
      api POST "https://monitoring.googleapis.com/v3/projects/$PROJECT/notificationChannels" "$body"
      [[ "$API_STATUS" == 200 ]] || { echo "creating the notification channel failed ($API_STATUS)" >&2; cat "$TMP/api.out" >&2; exit 1; }
      channel=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['name'])" "$TMP/api.out")
    fi
  fi
  ops_alert_policy deletion_overdue "$channel"
  ops_alert_policy stats_mismatch "$channel"
}

if ops_dry; then # no credentials, no network: print what a deploy would do
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/chords-deploy.XXXXXX")"
  trap 'rm -rf "$TMP"' EXIT
  gc() { printf '+ gcloud'; shell_quote "$@"; printf '\n'; }
  api() { printf '+ %s %s %s\n' "$1" "$2" "${3:-}"; }
  ALERT_EMAIL="<ALERT_EMAIL>" # a placeholder: the dry run never prints or sends the real address
  echo "max-instances guard: MAX_INSTANCES=$MAX_INSTANCES (ok); the service is deployed with --max-instances $MAX_INSTANCES"
  echo "dry run for project $PROJECT, region $REGION, service $SERVICE: nothing is sent to Google Cloud"
  ops_sweep_scheduler "https://$SERVICE-<project-number>.$REGION.run.app"
  ops_log_metrics
  ops_alerts
  exit 0
fi

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
    firestore.googleapis.com iam.googleapis.com iamcredentials.googleapis.com logging.googleapis.com \
    cloudscheduler.googleapis.com monitoring.googleapis.com

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
ALERT_EMAIL="${ALERT_EMAIL:-$(secret ALERT_EMAIL)}" # where the admin alerts go (optional; never committed)
[[ -n "$SIGNING_KEY" && -n "$SMOKE_KEY" ]] || { echo "$ENV_FILE lacks CHORDS_SIGNING_KEY / CHORDS_SMOKE_KEY" >&2; exit 1; }

# ------------------------------------------------------------------------------ build
if [[ -z "${SKIP_BUILD:-}" ]]; then
  TAG="${IMAGE_TAG:-$(date -u +%Y%m%d-%H%M%S)}"
  log "Cloud Build: $IMAGE:$TAG"
  # the build runs in the image's region: the cache pull of the ~0.9 GB previous image stays inside
  # it (from the global pool it was billed as intercontinental Artifact Registry egress)
  BUILD_ID=$(gc builds submit "$ROOT/backend" --config "$ROOT/backend/cloudbuild.yaml" --region "$REGION" \
    --substitutions "_IMAGE=$IMAGE,_TAG=$TAG" --async --format='value(id)')
  echo "build $BUILD_ID: https://console.cloud.google.com/cloud-build/builds;region=$REGION/$BUILD_ID?project=$PROJECT"
  while true; do
    STATUS=$(gc builds describe "$BUILD_ID" --region "$REGION" --format='value(status)')
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
  SRC=$(gc builds describe "$BUILD_ID" --region "$REGION" --format='value(source.storageSource.bucket,source.storageSource.object)' | tr '\t' '/')
  [[ -n "$SRC" && "$SRC" != "/" ]] && gc storage rm "gs://$SRC" >/dev/null 2>&1 || true
  DEPLOY_IMAGE="$IMAGE:$TAG"
else
  DEPLOY_IMAGE="$IMAGE:latest"
fi

# ------------------------------------------------------------------------------ deploy
log "Deploying $SERVICE ($DEPLOY_IMAGE)"
NUMBER=$(gc projects describe "$PROJECT" --format='value(projectNumber)')
STABLE_URL="https://$SERVICE-$NUMBER.$REGION.run.app" # the sweep's URL and the OIDC audience the server checks
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
CHORDS_MAX_INSTANCES: "$MAX_INSTANCES"
CHORDS_SCHEDULER_EMAIL: "$SCHEDULER_SA"
CHORDS_SCHEDULER_AUDIENCE: "$STABLE_URL"
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
  --max-instances "$MAX_INSTANCES" \
  --port 8080 \
  --allow-unauthenticated \
  --service-account "$RUNTIME_SA" \
  --env-vars-file "$TMP/env.yaml" \
  --clear-volumes --clear-volume-mounts \
  --add-volume "name=data,type=cloud-storage,bucket=$BUCKET,mount-options=uid=$APP_UID;gid=$APP_UID" \
  --add-volume-mount "volume=data,mount-path=/data" \
  --quiet

URL=$(gc run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')

# the deployed cap, as Cloud Run reports it (empty = could not read it: the guard above still held)
LIVE_CAP=$(gc run services describe "$SERVICE" --region "$REGION" \
  --format='value(spec.template.metadata.annotations."autoscaling.knative.dev/maxScale")' 2>/dev/null || true)
if [[ -n "$LIVE_CAP" && "$LIVE_CAP" != "1" ]]; then
  echo "the deployed service reports max-instances=$LIVE_CAP, expected 1 (admin quotas and limits are in-memory)" >&2
  exit 1
fi

if [[ -z "${SKIP_OPS:-}" ]]; then
  log "Admin ops: sweep scheduler jobs, log metrics, alerts"
  ops_sweep_scheduler "$STABLE_URL"
  ops_log_metrics
  ops_alerts
fi

log "Done in $(elapsed)"
echo "Service URL:      $URL"
echo "Stable URL:       $STABLE_URL"
echo "Health:           $(curl -fsS --max-time 120 "$URL/api/health" || echo 'not answering yet')"
