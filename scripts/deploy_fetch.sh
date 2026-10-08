#!/usr/bin/env bash
# Deploys chords-fetch (short YouTube fragments through Cloudflare WARP, docs/CLOUD.md → YouTube clips) to Cloud
# Run with what it needs: the WARP profile in Secret Manager, Cloud NAT for Direct VPC egress, its own service
# account. Idempotent: re-run it to redeploy. Then run scripts/deploy_cloud.sh so chords-api gets CHORDS_FETCH_URL.
#
#   scripts/deploy_fetch.sh                  everything: setup + Cloud Build + deploy + one direct fragment
#   SKIP_SETUP=1 scripts/deploy_fetch.sh     code-only redeploy (no APIs / secret / NAT / IAM steps)
#   SKIP_BUILD=1 scripts/deploy_fetch.sh     redeploy the newest image (settings only)
#
# The WARP profile: registered once with a local `wgcf` (brew install wgcf) after you confirm Cloudflare's terms,
# stored only as the secret `warp-profile`; never printed, never written into the repository.
# Cost: the Cloud NAT gateway + its IP ≈ $4–5 / month whether used or not; NAT data ≈ $0.045 / GB (a fragment is
# ~0.5 MB); the service itself stays in Cloud Run's free tier at this scale.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${PROJECT:-build-chords-listener}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-chords-fetch}"
REPO="${REPO:-chords}"
BUCKET="${BUCKET:-$PROJECT.firebasestorage.app}"
IMAGE="$REGION-docker.pkg.dev/$PROJECT/$REPO/fetch"
FETCH_SA_NAME="${FETCH_SA_NAME:-chords-fetch}"
FETCH_SA="$FETCH_SA_NAME@$PROJECT.iam.gserviceaccount.com"
API_SA="${API_SA:-chords-api@$PROJECT.iam.gserviceaccount.com}"
SECRET="${SECRET:-warp-profile}"
NETWORK="${NETWORK:-default}"
SUBNET="${SUBNET:-default}"
ROUTER="${ROUTER:-chords-nat-router}"
NAT="${NAT:-chords-nat}"
FETCH_MAX_INSTANCES="${FETCH_MAX_INSTANCES:-3}"
PROFILE_MOUNT=/secrets/warp/wgcf-profile.conf

for tool in node curl python3; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/chords-fetch-deploy.XXXXXX")"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
# shellcheck source=scripts/gcloud_common.sh
source "$ROOT/scripts/gcloud_common.sh"

log "Project $PROJECT, region $REGION, service $SERVICE (auth: $AUTH_MODE)"

if [[ -z "${SKIP_SETUP:-}" ]]; then
  # ---------------------------------------------------------------------------- APIs
  log "Enabling APIs"
  gc services enable secretmanager.googleapis.com compute.googleapis.com run.googleapis.com \
    cloudbuild.googleapis.com artifactregistry.googleapis.com iam.googleapis.com

  # ---------------------------------------------------------------------------- WARP profile
  log "WARP profile (secret $SECRET)"
  if gc secrets describe "$SECRET" >/dev/null 2>&1; then
    echo "exists"
  else
    command -v wgcf >/dev/null || { echo "wgcf is needed once to register the WARP device: brew install wgcf" >&2; exit 1; }
    [[ -t 0 ]] || { echo "registering the WARP device needs your confirmation: run this script in a terminal" >&2; exit 1; }
    echo "This registers ONE new Cloudflare WARP device for chords-fetch and accepts Cloudflare's terms of service"
    echo "(https://www.cloudflare.com/application/terms/). The profile is stored only in Secret Manager."
    read -r -p "Register it now? [y/N] " answer
    [[ "$answer" == [yY]* ]] || { echo "stopped: no WARP profile" >&2; exit 1; }
    (cd "$TMP" && umask 077 && wgcf register --accept-tos >/dev/null && wgcf generate >/dev/null)
    gc secrets create "$SECRET" --replication-policy=automatic --data-file="$TMP/wgcf-profile.conf" >/dev/null
    rm -f "$TMP/wgcf-profile.conf" "$TMP/wgcf-account.toml"
    echo "stored as secret $SECRET"
  fi

  # ---------------------------------------------------------------------------- Cloud NAT
  # Direct VPC egress + Cloud NAT: the only egress on which WireGuard (WARP) carries real payloads from Cloud Run
  log "Cloud NAT $NAT (router $ROUTER, $REGION) + Private Google Access on $SUBNET"
  gc compute routers describe "$ROUTER" --region "$REGION" >/dev/null 2>&1 \
    || gc compute routers create "$ROUTER" --network "$NETWORK" --region "$REGION"
  gc compute routers nats describe "$NAT" --router "$ROUTER" --region "$REGION" >/dev/null 2>&1 \
    || gc compute routers nats create "$NAT" --router "$ROUTER" --region "$REGION" \
         --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges
  # the bucket and the token endpoints are reached without NAT
  gc compute networks subnets update "$SUBNET" --region "$REGION" --enable-private-ip-google-access

  # ---------------------------------------------------------------------------- service account + IAM
  log "Service account $FETCH_SA"
  if ! gc iam service-accounts describe "$FETCH_SA" >/dev/null 2>&1; then
    gc iam service-accounts create "$FETCH_SA_NAME" --display-name="Chords Listener fetch (Cloud Run)"
  fi
  for attempt in 1 2 3 4 5 6; do # a new service account takes a moment to become usable in IAM
    if gc storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$FETCH_SA" \
        --role=roles/storage.objectUser \
        --condition="expression=resource.name.startsWith('projects/_/buckets/$BUCKET/objects/fetch/'),title=fetch-only,description=chords-fetch writes only under fetch/" \
        >/dev/null 2>"$TMP/iam.err"; then
      echo "roles/storage.objectUser on gs://$BUCKET/fetch/ only"; break
    fi
    [[ $attempt == 6 ]] && { cat "$TMP/iam.err" >&2; exit 1; }
    sleep 10
  done
  gc secrets add-iam-policy-binding "$SECRET" --member="serviceAccount:$FETCH_SA" \
    --role=roles/secretmanager.secretAccessor >/dev/null
  echo "roles/secretmanager.secretAccessor on $SECRET"

  log "Artifact Registry repository $REPO"
  if ! gc artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1; then
    gc artifacts repositories create "$REPO" --repository-format=docker --location "$REGION" \
      --description="Chords Listener images"
  fi
fi

# ------------------------------------------------------------------------------ build
if [[ -z "${SKIP_BUILD:-}" ]]; then
  TAG="${IMAGE_TAG:-$(date -u +%Y%m%d-%H%M%S)}"
  log "Cloud Build: $IMAGE:$TAG"
  cloud_build "$ROOT/backend/fetch.cloudbuild.yaml" "$IMAGE" "$TAG"
  DEPLOY_IMAGE="$IMAGE:$TAG"
else
  DEPLOY_IMAGE="$IMAGE:latest"
fi

# ------------------------------------------------------------------------------ deploy
log "Deploying $SERVICE ($DEPLOY_IMAGE)"
gc run deploy "$SERVICE" \
  --image "$DEPLOY_IMAGE" \
  --region "$REGION" \
  --execution-environment gen2 \
  --cpu 1 --memory 1Gi \
  --cpu-throttling \
  --cpu-boost \
  --concurrency 1 \
  --min-instances 0 \
  --max-instances "$FETCH_MAX_INSTANCES" \
  --timeout 300 \
  --port 8080 \
  --no-allow-unauthenticated \
  --service-account "$FETCH_SA" \
  --network "$NETWORK" --subnet "$SUBNET" --vpc-egress all-traffic \
  --set-secrets "$PROFILE_MOUNT=$SECRET:latest" \
  --set-env-vars "FETCH_BUCKET=$BUCKET,WARP_PROFILE=$PROFILE_MOUNT,FETCH_WORK_DIR=/tmp/chords-fetch" \
  --quiet
gc run services add-iam-policy-binding "$SERVICE" --region "$REGION" \
  --member="serviceAccount:$API_SA" --role=roles/run.invoker >/dev/null
echo "roles/run.invoker for $API_SA"

URL=$(gc run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')

# ------------------------------------------------------------------------------ smoke: one fragment, straight
if ID_TOKEN=$("$GCLOUD" auth print-identity-token 2>/dev/null) && [[ -n "$ID_TOKEN" ]]; then
  log "Smoke: one fragment straight from $SERVICE"
  (umask 077; printf 'Authorization: Bearer %s\n' "$ID_TOKEN" > "$TMP/id.hdr")
  STATUS=$(curl -sS --max-time 300 -o "$TMP/clip.json" -w '%{http_code}' -H @"$TMP/id.hdr" \
    -H 'Content-Type: application/json' --data '{"videoId":"dQw4w9WgXcQ","start":60,"length":30}' "$URL/clip" || echo 000)
  rm -f "$TMP/id.hdr"
  echo "HTTP $STATUS"
  OBJECT=$(python3 - "$TMP/clip.json" <<'PY' || true
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
print({k: d.get(k) for k in ("title", "start", "end", "size", "code", "message")}, file=sys.stderr)
print(d.get("path") or "")
PY
)
  if [[ -n "$OBJECT" ]]; then gc storage rm "gs://$BUCKET/$OBJECT" >/dev/null 2>&1 || true; fi
  [[ "$STATUS" == 200 ]] || echo "the direct fragment failed: see the logs of $SERVICE" >&2
else
  echo "no gcloud identity token (firebase-tools login): skipped the direct fragment; run scripts/smoke_fetch.py"
fi

log "Done in $(elapsed)"
echo "Service URL: $URL"
echo "Next: scripts/deploy_cloud.sh (sets CHORDS_FETCH_URL on chords-api), then python3 scripts/smoke_fetch.py"
