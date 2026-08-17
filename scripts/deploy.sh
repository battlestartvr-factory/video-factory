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

log "Fetching origin/main"
git fetch origin main

if [[ -n "$COMMIT" ]]; then
  log "Checking out commit $COMMIT"
  git checkout --detach "$COMMIT"
else
  log "Fast-forwarding to origin/main"
  git checkout main
  git pull --ff-only origin main
fi

log "Loading production env from $ENV_FILE"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

export AI_FACTORY_ENV_FILE="$ENV_FILE"
export AI_FACTORY_DATA_ROOT="$DATA_ROOT"

: "${NEXT_PUBLIC_SUPABASE_URL:?NEXT_PUBLIC_SUPABASE_URL is required in $ENV_FILE}"
: "${NEXT_PUBLIC_SUPABASE_ANON_KEY:?NEXT_PUBLIC_SUPABASE_ANON_KEY is required in $ENV_FILE}"

log "Building Docker images"
docker compose -f "$COMPOSE_FILE" build --pull

log "Starting services"
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

log "Waiting for app health (timeout ${HEALTH_TIMEOUT_SECONDS}s)"
deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
while (( SECONDS < deadline )); do
  health_status="$(docker compose -f "$COMPOSE_FILE" ps app --format '{{.Health}}' 2>/dev/null || true)"
  if [[ "$health_status" == "healthy" ]]; then
    if curl -fsS "http://127.0.0.1/api/health" >/dev/null 2>&1; then
      log "Deployment healthy via Caddy"
      docker compose -f "$COMPOSE_FILE" ps
      exit 0
    fi
    if curl -fsS "http://127.0.0.1:3000/api/health" >/dev/null 2>&1; then
      log "Deployment healthy on app port"
      docker compose -f "$COMPOSE_FILE" ps
      exit 0
    fi
  fi
  sleep "$HEALTH_POLL_SECONDS"
done

log "Health check failed — recent app logs:"
docker compose -f "$COMPOSE_FILE" logs --tail=80 app || true
fail "Deployment failed health check within ${HEALTH_TIMEOUT_SECONDS}s"
