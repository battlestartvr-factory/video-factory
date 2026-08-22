# Docker production deployment

**Current production topology — updated 2026-08-22.** Historical Vercel cutover is complete; Vercel is no longer the production fallback/authority.

## Paths

| Path | Purpose |
|---|---|
| `/opt/ai-factory/app` | Git checkout |
| `/opt/ai-factory/.env` | Production secrets/config, not in Git |
| `/srv/ai-factory` | Shared durable/scratch root and assembly workspace |

## Public endpoint

`https://battlestart-factory.duckdns.org`

Caddy terminates HTTPS on ports 80/443 and proxies to `app:3000`.

## Compose topology

```text
data-init
  -> prepares /srv/ai-factory/discovery-assembly-{staging,output}

caddy
  -> app:3000

app
  -> Supabase
  -> KIE
  -> Google Drive
  -> B2 ingest when used

worker
  ORCHESTRATOR_QUEUE_MODE=core
  WORKER_CONCURRENCY=1

research-worker
  ORCHESTRATOR_QUEUE_MODE=research
  WORKER_CONCURRENCY=5
```

Both workers build from `Dockerfile.worker`, share `/srv/ai-factory`, and publish `BUILD_SHA=${DEPLOY_COMMIT}` in worker heartbeats.

## Main files

| File | Purpose |
|---|---|
| `Dockerfile` | Next.js production image |
| `Dockerfile.worker` | durable worker image with FFmpeg runtime |
| `docker-compose.yml` | app + two workers + Caddy + data-init |
| `deploy/Caddyfile` | production HTTPS/reverse proxy/SSE timeouts |
| `deploy/env.production.example` | production env template |
| `scripts/deploy.sh` | exact-SHA schema-fenced deployment |
| `.github/workflows/deploy-production.yml` | automatic/manual production release |

## Caddy behavior

Current Caddy configuration:

- automatic TLS for `battlestart-factory.duckdns.org`;
- gzip + zstd;
- request body max 20MB;
- SSE `flush_interval -1`;
- `dial_timeout 10s`;
- `read_timeout` / `write_timeout` 6m.

This supports chat SSE and bounded long-running internal routes.

## Assembly workspace

`data-init` ensures these directories exist and are writable by worker UID/GID 1001:

- `/srv/ai-factory/discovery-assembly-staging`;
- `/srv/ai-factory/discovery-assembly-output`.

Deploy validates:

- worker can create/write there;
- app can read staging;
- FFmpeg/ffprobe exist in worker image.

FFmpeg is **actively used** by current Game Discovery prototype assembly; it is no longer only a future dependency.

## Runtime environment

Compose forces/sets important runtime values:

### app

- `NODE_ENV=production`;
- `HOSTNAME=0.0.0.0`;
- `PORT=3000`;
- `AI_FACTORY_DATA_ROOT=/srv/ai-factory`;
- `GOOGLE_DRIVE_AUTH_MODE=oauth_user`;
- `WEB_SEARCH_PROVIDER=${WEB_SEARCH_PROVIDER:-kie}`.

### core worker

- same data root;
- `BUILD_SHA=${DEPLOY_COMMIT:-local}`;
- `WORKER_APP_INTERNAL_URL=http://app:3000`;
- `ORCHESTRATOR_QUEUE_MODE=core`;
- `WORKER_CONCURRENCY=1`;
- Drive auth `oauth_user`;
- web search default `kie`.

### research worker

- `ORCHESTRATOR_QUEUE_MODE=research`;
- `WORKER_CONCURRENCY=5`;
- same worker image/KIE/Supabase/internal app configuration.

## Quick server bootstrap

Initial provisioning only:

```bash
sudo install -d -m 755 /opt/ai-factory /srv/ai-factory
sudo git clone https://github.com/battlestartvr-factory/video-factory.git /opt/ai-factory/app
sudo cp /opt/ai-factory/app/deploy/env.production.example /opt/ai-factory/.env
sudo chmod 640 /opt/ai-factory/.env
# fill real server-side values
```

Normal releases should use GitHub `Deploy Production`, not manual `git pull` + ad-hoc compose commands.

## Manual deploy / recovery

When explicitly required:

```bash
cd /opt/ai-factory/app
./scripts/deploy.sh <exact-commit-sha>
```

The script still enforces schema contract, Drive OAuth, health and exact checkout.

Prefer workflow `rollback` over manually editing production checkout.

## Health and acceptance

- Docker app health: `http://127.0.0.1:3000/api/health` inside app context;
- public health: `https://battlestart-factory.duckdns.org/api/health`;
- core/research workers: `orchestrator_workers.last_heartbeat_at` + exact `build_sha`;
- production schema: `deployment_schema_contract` RPC/table;
- Compose: `docker compose ps`.

## Secrets

Real values stay only in production secret stores/env. Do not commit:

- Supabase server key;
- KIE key;
- Drive OAuth secrets/refresh token;
- B2 credentials;
- webhook/deploy keys.

See `docs/environment-inventory.md`.

## Historical note

The project previously ran from Vercel/n8n-first assumptions. Those constraints are retained in historical documents only. A legacy Vercel GitHub check may still appear, but current Docker/VPS production decisions must not depend on it.