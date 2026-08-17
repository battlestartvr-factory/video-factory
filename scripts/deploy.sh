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
LAST_GOOD_FILE="${LAST_GOOD_FILE:-/opt/ai-factory/last-good-commit}"
ROLLBACK_CANDIDATE_FILE="${ROLLBACK_CANDIDATE_FILE:-/opt/ai-factory/rollback-candidate-commit}"

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

# A manual pre-merge deployment can target a commit that is not reachable from main yet.
# Do not depend on a previous preflight having populated the Git object store.
if [[ -n "$COMMIT" ]] && ! git cat-file -e "${COMMIT}^{commit}" 2>/dev/null; then
  log "Target commit is not local; fetching advertised origin branches"
  git fetch origin '+refs/heads/*:refs/remotes/origin/*'
fi
if [[ -n "$COMMIT" ]]; then
  git cat-file -e "${COMMIT}^{commit}" 2>/dev/null || fail "Target commit is unavailable after fetch: $COMMIT"
fi

# Production working tree is deployment-only. Discard tracked manual edits so
# checkout of the CI-approved commit is deterministic. Secrets and persistent
# data live outside the repository and are not affected by this reset.
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

log "Building Docker images"
docker compose -f "$COMPOSE_FILE" build --pull

log "Starting services"
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

log "Waiting for app health and durable worker (timeout ${HEALTH_TIMEOUT_SECONDS}s)"
deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
while (( SECONDS < deadline )); do
  health_status="$(docker compose -f "$COMPOSE_FILE" ps app --format '{{.Health}}' 2>/dev/null || true)"
  worker_running="$(docker compose -f "$COMPOSE_FILE" ps worker --status running --services 2>/dev/null || true)"
  if [[ "$health_status" == "healthy" && "$worker_running" == "worker" ]]; then
    if curl -fsS "http://127.0.0.1/api/health" >/dev/null 2>&1 || \
       curl -fsS "http://127.0.0.1:3000/api/health" >/dev/null 2>&1; then
      deployed_commit="$(git rev-parse HEAD)"
      mkdir -p "$(dirname "$LAST_GOOD_FILE")" "$(dirname "$ROLLBACK_CANDIDATE_FILE")"
      printf '%s\n' "$ROLLBACK_CANDIDATE" > "$ROLLBACK_CANDIDATE_FILE"
      printf '%s\n' "$deployed_commit" > "$LAST_GOOD_FILE"
      log "Deployment healthy; durable worker running"
      log "Recorded last-good commit: $deployed_commit"
      log "Recorded rollback candidate: $ROLLBACK_CANDIDATE"
      docker compose -f "$COMPOSE_FILE" ps
      exit 0
    fi
  fi
  sleep "$HEALTH_POLL_SECONDS"
done

log "Health check failed — recent app logs:"
docker compose -f "$COMPOSE_FILE" logs --tail=80 app || true
log "Recent worker logs:"
docker compose -f "$COMPOSE_FILE" logs --tail=80 worker || true
log "Rollback candidate remains: $ROLLBACK_CANDIDATE"
fail "Deployment failed health check within ${HEALTH_TIMEOUT_SECONDS}s"
