# Environment inventory

**Updated from current runtime code / Compose / deploy scripts: 2026-08-22.**

Never store real values in Git. This document lists names and behavior only.

## Core application / Supabase

| Variable | Purpose | Production status | Secret |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL, build + runtime | required | no |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser/auth public key | required | no |
| `SUPABASE_SERVICE_ROLE_KEY` | server/worker service writes | required unless alternate server key used | **yes** |
| `SUPABASE_SECRET_KEY` | alternate modern server secret fallback | optional fallback | **yes** |
| `APP_URL` | public HTTPS app URL/callback base | required by production preflight | no |
| `LOG_LEVEL` | server logging level | optional | no |
| `MOCK_WORKFLOWS` | mock durable/provider behavior | must be `false` in production | no |

Production `APP_URL` must be public HTTPS and must not be localhost.

## KIE / models / research

| Variable | Purpose | Default/status | Secret |
|---|---|---|---|
| `KIE_API_KEY` | canonical KIE API key for LLM/image/video/research | required production | **yes** |
| `KIE_API_BASE_URL` | KIE root | `https://api.kie.ai` | no |
| `KIE_WEB_SEARCH_MODEL` | shared-pool grounded search model override | default `gemini-3-6-flash` | no |
| `WEB_SEARCH_PROVIDER` | generic/web subsystem provider selector | Compose defaults to `kie` | no |
| `WEB_SEARCH_API_KEY` | legacy/alternative non-KIE search provider key | only when such provider selected | **yes** |
| `WEB_SEARCH_BASE_URL` | generic alternative search endpoint | optional | no |

V3 Game Discovery production shared-pool search directly uses `KIE_API_KEY` and defaults to `gemini-3-6-flash`; a second search subscription is not required for that path.

## Durable worker / orchestration

Read by `worker/config.ts` unless Compose fixes the value.

| Variable | Purpose | Default / production shape |
|---|---|---|
| `ORCHESTRATOR_WORKER_ID` | explicit worker id override | generated from host/pid/random if omitted |
| `ORCHESTRATOR_QUEUE_MODE` | `core` or `research` | Compose: core for `worker`, research for `research-worker` |
| `WORKER_CONCURRENCY` | concurrent claimed deliveries | Compose: 1 core, 5 research |
| `ORCHESTRATOR_QUEUE_POLL_MS` | queue poll interval | 1000ms |
| `ORCHESTRATOR_LEASE_SECONDS` | DB lease duration | 90s |
| `ORCHESTRATOR_VISIBILITY_SECONDS` | queue visibility duration | 120s |
| `ORCHESTRATOR_LEASE_HEARTBEAT_MS` | lease heartbeat / cancellation fence | 1000ms |
| `ORCHESTRATOR_WORKER_HEARTBEAT_MS` | worker registry heartbeat | 15000ms |
| `ORCHESTRATOR_WATCHDOG_MS` | stale/due job recovery interval | 60000ms |
| `ORCHESTRATOR_MAX_ATTEMPTS` | max technical retry attempts | 5 |
| `WORKER_APP_INTERNAL_URL` | worker -> internal app API | Compose `http://app:3000` |
| `BUILD_SHA` | worker build identity | Compose from `DEPLOY_COMMIT` |
| `GIT_COMMIT` | fallback build identity | optional |

Constraint: lease heartbeat must be shorter than DB lease.

Do not casually increase concurrency/retries: research and paid-provider cost boundaries depend on bounded execution.

## VPS / Compose / deployment

| Variable | Purpose | Default/status |
|---|---|---|
| `AI_FACTORY_ENV_FILE` | Compose/deploy env path | `/opt/ai-factory/.env` |
| `AI_FACTORY_DATA_ROOT` | host shared data root | `/srv/ai-factory` |
| `DEPLOY_COMMIT` | exact release SHA passed into Compose/build | set by deploy workflow/script |
| `COMPOSE_FILE` | deploy compose override | `docker-compose.yml` |
| `HEALTH_TIMEOUT_SECONDS` | deployment health wait | 180 |
| `HEALTH_POLL_SECONDS` | deployment health polling | 3 |
| `LAST_GOOD_FILE` | last-good SHA marker | under `/srv/ai-factory` |
| `ROLLBACK_CANDIDATE_FILE` | rollback SHA marker | under `/srv/ai-factory` |

GitHub Actions production secrets (not app env):

- `DEPLOY_HOST`;
- `DEPLOY_USER`;
- `DEPLOY_SSH_KEY` or `DEPLOY_SSH_KEY_B64`.

## Google Drive

Production release currently requires owner OAuth durable archive health.

| Variable | Purpose | Production status | Secret |
|---|---|---|---|
| `GOOGLE_DRIVE_INTEGRATION_ENABLED` | enable durable Drive paths | **must be true in production deploy** | no |
| `GOOGLE_DRIVE_AUTH_MODE` | auth mode | Compose/deploy forces `oauth_user` | no |
| `GOOGLE_DRIVE_SHARED_FOLDER_ID` | archive root | required production | no |
| `GOOGLE_DRIVE_CLIENT_ID` | owner OAuth client | required production | no |
| `GOOGLE_DRIVE_CLIENT_SECRET` | owner OAuth secret | required production | **yes** |
| `GOOGLE_DRIVE_REFRESH_TOKEN` | pre-issued owner OAuth refresh token | required production | **yes** |
| `GOOGLE_DRIVE_CLIENT_EMAIL` | legacy/service-account mode email | non-production/legacy path only | no |
| `GOOGLE_DRIVE_PRIVATE_KEY` | service-account private key | non-production/legacy path only | **yes** |

Google Drive stores durable binaries/pointers for knowledge/reference/media archive paths. Do not place OAuth values in client forms.

## Gameplay Reference periodic sync

Worker code has a core-worker Drive sync loop. Environment overrides may be used by the corresponding helper if present in current code; keep operational values bounded and do not enable a high-frequency expensive caption loop. Canonical paid caption invariant remains one caption provider call per reference attempt.

## Backblaze B2 / asset ingest

| Variable | Purpose | Required when ingest path is used | Secret |
|---|---|---|---|
| `INGEST_PROXY_TOKEN` | internal ingest authorization | yes | **yes** |
| `B2_S3_ENDPOINT` | B2 S3 endpoint | yes | no |
| `B2_REGION` | B2 region | yes | no |
| `B2_ACCESS_KEY_ID` | access key | yes | **yes** |
| `B2_SECRET_ACCESS_KEY` | secret | yes | **yes** |
| `B2_BUCKET` | temp bucket | default example `battlestart-factory-temp` | no |

B2 is temp ingest storage, not authoritative discovery memory/archive.

## Legacy n8n generic job lane

These variables remain because legacy/generic content code paths still exist, but they are **not part of current Game Discovery v3 orchestration**:

- `N8N_WEBHOOK_URL`;
- `N8N_WEBHOOK_SECRET`;
- `N8N_FACTORY_BASE_URL`;
- `FACTORY_WEBHOOK_SECRET`.

Do not provision new n8n dependencies for v3 Discovery unless an explicit future product decision reuses that lane.

## Deprecated LLM aliases

- `AGENT_LLM_API_KEY` — fallback alias used by some KIE-compatible code;
- `AGENT_LLM_BASE_URL` — fallback base URL alias;
- `AGENT_LLM_DEFAULT_MODEL` — legacy optional override;
- `AGENT_LLM_ALLOWED_MODELS` — registry is canonical; remove only after confirming no deployment/runtime consumer remains.

New code should prefer KIE registry/current policy rather than adding more `AGENT_LLM_*` behavior.

## Public vs secret rule

Only intentionally public browser configuration may use `NEXT_PUBLIC_*`.

Never expose:

- Supabase service/secret key;
- KIE API key;
- Google OAuth client secret/refresh token;
- B2 secret;
- webhook secrets;
- deploy SSH keys.

## Production acceptance query targets

After deploy, verify configuration indirectly rather than printing secrets:

- app health;
- schema contract;
- `orchestrator_workers.build_sha` + fresh heartbeat;
- `mock_workflows=false` in heartbeat metadata;
- `provider_models` rows enabled;
- Drive OAuth/archive-root health script result.

Do not dump `/opt/ai-factory/.env` into logs or chat.