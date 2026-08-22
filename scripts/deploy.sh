#!/usr/bin/env bash
# Production deploy script for Ubuntu VPS.
# Usage: deploy.sh [commit-sha]
# Env file default: /opt/ai-factory/.env

set -euo pipefail

COMMIT="${1:-}"
APP_DIR="${APP_DIR:-/opt/ai-factory/app}"
ENV_FILE="${AI_FACTORY_ENV_FILE:-/opt/ai-factory/.env}"
DATA_ROOT="${AI_FACTORY_DATA_ROOT:-/srv/ai-factory}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"
HEALTH_POLL_SECONDS="${HEALTH_POLL_SECONDS:-3}"
LAST_GOOD_FILE="${LAST_GOOD_FILE:-$DATA_ROOT/.deploy-last-good-commit}"
ROLLBACK_CANDIDATE_FILE="${ROLLBACK_CANDIDATE_FILE:-$DATA_ROOT/.deploy-rollback-candidate-commit}"

log() {
  printf '[deploy] %s\n' "$*"
}

fail() {
  printf '[deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require_command git
require_command docker
require_command curl

[[ -d "$APP_DIR" ]] || fail "Application directory not found: $APP_DIR"
[[ -f "$ENV_FILE" ]] || fail "Env file not found: $ENV_FILE"

mkdir -p "$DATA_ROOT"

cd "$APP_DIR"

CURRENT_COMMIT="$(git rev-parse HEAD)"
ROLLBACK_CANDIDATE="$CURRENT_COMMIT"
if [[ -f "$LAST_GOOD_FILE" ]]; then
  recorded_last_good="$(tr -d '\r\n[:space:]' < "$LAST_GOOD_FILE")"
  if [[ -n "$recorded_last_good" ]] && git cat-file -e "${recorded_last_good}^{commit}" 2>/dev/null; then
    ROLLBACK_CANDIDATE="$recorded_last_good"
  fi
fi
log "Current checkout: $CURRENT_COMMIT"
log "Rollback candidate: $ROLLBACK_CANDIDATE"

log "Fetching origin/main"
git fetch origin main

if [[ -n "$COMMIT" ]] && ! git cat-file -e "${COMMIT}^{commit}" 2>/dev/null; then
  log "Target commit is not local; fetching advertised origin branches"
  git fetch origin '+refs/heads/*:refs/remotes/origin/*'
fi
if [[ -n "$COMMIT" ]]; then
  git cat-file -e "${COMMIT}^{commit}" 2>/dev/null || fail "Target commit is unavailable after fetch: $COMMIT"
fi

log "Resetting tracked local changes"
git reset --hard HEAD

if [[ -n "$COMMIT" ]]; then
  log "Checking out commit $COMMIT"
  git checkout --detach "$COMMIT"
else
  log "Fast-forwarding to origin/main"
  git checkout main
  git reset --hard origin/main
fi

log "Validating checked-in schema contract"
bash scripts/check-schema-contract.sh
EXPECTED_SCHEMA_VERSION="$(tr -d '\r\n[:space:]' < supabase/schema-contract.txt)"

log "Loading production env from $ENV_FILE"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

export AI_FACTORY_ENV_FILE="$ENV_FILE"
export AI_FACTORY_DATA_ROOT="$DATA_ROOT"
export DEPLOY_COMMIT="$(git rev-parse HEAD)"

: "${NEXT_PUBLIC_SUPABASE_URL:?NEXT_PUBLIC_SUPABASE_URL is required in $ENV_FILE}"
: "${NEXT_PUBLIC_SUPABASE_ANON_KEY:?NEXT_PUBLIC_SUPABASE_ANON_KEY is required in $ENV_FILE}"
if [[ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" && -z "${SUPABASE_SECRET_KEY:-}" ]]; then
  fail "SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY is required for the durable worker"
fi
SUPABASE_SERVER_KEY="${SUPABASE_SERVICE_ROLE_KEY:-${SUPABASE_SECRET_KEY:-}}"

release_worker_ready() {
  local queue_mode="$1"
  local response=""
  local compact=""

  if ! response="$(curl -sS --fail-with-body --max-time 10 \
    -X POST "${NEXT_PUBLIC_SUPABASE_URL%/}/rest/v1/rpc/orchestrator_release_worker_ready" \
    -H "apikey: ${SUPABASE_SERVER_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVER_KEY}" \
    -H "Content-Type: application/json" \
    --data "{\"p_build_sha\":\"${DEPLOY_COMMIT}\",\"p_queue_mode\":\"${queue_mode}\",\"p_not_before\":\"${WORKER_HEARTBEAT_NOT_BEFORE}\"}")"; then
    return 1
  fi

  compact="$(printf '%s' "$response" | tr -d '\r\n[:space:]')"
  [[ "$compact" == "true" ]]
}

log "Verifying production database schema contract"
schema_contract_response=""
if ! schema_contract_response="$(curl -sS --fail-with-body --max-time 20 \
  -X POST "${NEXT_PUBLIC_SUPABASE_URL%/}/rest/v1/rpc/orchestrator_get_deployment_schema_contract" \
  -H "apikey: ${SUPABASE_SERVER_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVER_KEY}" \
  -H "Content-Type: application/json" \
  --data '{}')"; then
  fail "Unable to read production database schema contract; apply required Supabase migrations before deploying application code"
fi
schema_contract_compact="$(printf '%s' "$schema_contract_response" | tr -d '\r\n[:space:]')"
DATABASE_SCHEMA_VERSION=""
if [[ "$schema_contract_compact" =~ \"schema_version\":\"([0-9]{14})\" ]]; then
  DATABASE_SCHEMA_VERSION="${BASH_REMATCH[1]}"
fi
[[ -n "$DATABASE_SCHEMA_VERSION" ]] || fail "Production database returned an invalid schema contract: $schema_contract_response"
if [[ "$DATABASE_SCHEMA_VERSION" != "$EXPECTED_SCHEMA_VERSION" ]]; then
  fail "Database schema drift: production=$DATABASE_SCHEMA_VERSION application=$EXPECTED_SCHEMA_VERSION. Apply Supabase migrations first; application deploy is blocked."
fi
log "Database schema contract matches application: $EXPECTED_SCHEMA_VERSION"

[[ "${GOOGLE_DRIVE_INTEGRATION_ENABLED:-false}" == "true" ]] || fail "GOOGLE_DRIVE_INTEGRATION_ENABLED=true is required for durable media archive"
: "${GOOGLE_DRIVE_SHARED_FOLDER_ID:?GOOGLE_DRIVE_SHARED_FOLDER_ID is required for durable media archive}"
: "${GOOGLE_DRIVE_CLIENT_ID:?GOOGLE_DRIVE_CLIENT_ID is required for owner Drive OAuth}"
: "${GOOGLE_DRIVE_CLIENT_SECRET:?GOOGLE_DRIVE_CLIENT_SECRET is required for owner Drive OAuth}"
: "${GOOGLE_DRIVE_REFRESH_TOKEN:?GOOGLE_DRIVE_REFRESH_TOKEN is required for owner Drive OAuth}"
export GOOGLE_DRIVE_AUTH_MODE=oauth_user
log "Google Drive auth mode: oauth_user (owner credentials)"

log "Verifying live Google Drive owner OAuth before service restart"
bash scripts/check-google-drive-oauth.sh

log "Building Docker images"
docker compose -f "$COMPOSE_FILE" build --pull

WORKER_HEARTBEAT_NOT_BEFORE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "Starting services"
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

log "Validating and reloading Caddy configuration"
if ! docker compose -f "$COMPOSE_FILE" exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
  fail "Caddy configuration validation failed"
fi
if ! docker compose -f "$COMPOSE_FILE" exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
  fail "Caddy configuration reload failed"
fi
log "Caddy configuration reloaded"

log "Verifying shared assembly workspace permissions"
if ! docker compose -f "$COMPOSE_FILE" exec -T worker sh -lc '
  set -eu
  for dir in /srv/ai-factory/discovery-assembly-staging /srv/ai-factory/discovery-assembly-output; do
    mkdir -p "$dir"
    test -d "$dir"
    test -w "$dir"
  done
'; then
  fail "Durable worker cannot write to the shared discovery assembly workspace"
fi
if ! docker compose -f "$COMPOSE_FILE" exec -T app sh -lc '
  set -eu
  test -r /srv/ai-factory/discovery-assembly-staging
'; then
  fail "App cannot read the shared discovery assembly staging workspace"
fi
log "Shared assembly workspace is writable by worker and readable by app"

log "Waiting for app health plus exact-release core/research workers (timeout ${HEALTH_TIMEOUT_SECONDS}s)"
deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
while (( SECONDS < deadline )); do
  health_status="$(docker compose -f "$COMPOSE_FILE" ps app --format '{{.Health}}' 2>/dev/null || true)"
  worker_running="$(docker compose -f "$COMPOSE_FILE" ps worker --status running --services 2>/dev/null || true)"
  research_worker_running="$(docker compose -f "$COMPOSE_FILE" ps research-worker --status running --services 2>/dev/null || true)"

  if [[ "$health_status" == "healthy" && "$worker_running" == "worker" && "$research_worker_running" == "research-worker" ]]; then
    if curl -fsS "http://127.0.0.1/api/health" >/dev/null 2>&1 || \
       curl -fsS "http://127.0.0.1:3000/api/health" >/dev/null 2>&1; then
      if release_worker_ready "core" && release_worker_ready "research"; then
        deployed_commit="$(git rev-parse HEAD)"

        log "Backfilling recent completed media into Google Drive"
        archive_result=""
        if ! archive_result="$(docker compose -f "$COMPOSE_FILE" exec -T app sh -lc '
          token="${SUPABASE_SERVICE_ROLE_KEY:-${SUPABASE_SECRET_KEY:-}}"
          curl -sS --fail-with-body --max-time 300 -X POST http://127.0.0.1:3000/api/internal/generation-archive/backfill \
            -H "Authorization: Bearer ${token}" \
            -H "Accept: application/json"
        ' 2>&1)"; then
          fail "Media archive backfill failed: $archive_result"
        fi
        log "Media archive backfill: $archive_result"

        mkdir -p "$(dirname "$LAST_GOOD_FILE")" "$(dirname "$ROLLBACK_CANDIDATE_FILE")"
        printf '%s\n' "$ROLLBACK_CANDIDATE" > "$ROLLBACK_CANDIDATE_FILE"
        printf '%s\n' "$deployed_commit" > "$LAST_GOOD_FILE"
        log "Deployment healthy; core and research workers are fresh, exact SHA, and mock_workflows=false"
        log "Recorded last-good commit: $deployed_commit"
        log "Recorded rollback candidate: $ROLLBACK_CANDIDATE"
        docker compose -f "$COMPOSE_FILE" ps
        exit 0
      fi
    fi
  fi
  sleep "$HEALTH_POLL_SECONDS"
done

log "Health check failed — recent app logs:"
docker compose -f "$COMPOSE_FILE" logs --tail=80 app || true
log "Recent core worker logs:"
docker compose -f "$COMPOSE_FILE" logs --tail=80 worker || true
log "Recent research worker logs:"
docker compose -f "$COMPOSE_FILE" logs --tail=80 research-worker || true
log "Rollback candidate remains: $ROLLBACK_CANDIDATE"
fail "Deployment failed health/exact-release worker acceptance within ${HEALTH_TIMEOUT_SECONDS}s"
