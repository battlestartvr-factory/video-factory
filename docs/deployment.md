# Deployment — canonical production guide

**Updated:** 2026-08-22

## Production target

Primary production is **Ubuntu VPS + Docker Engine/Compose + Caddy**.

- Public app: `https://battlestart-factory.duckdns.org`
- App checkout: `/opt/ai-factory/app`
- Production env: `/opt/ai-factory/.env`
- Shared data/assembly root: `/srv/ai-factory`
- Supabase: managed production project
- Provider layer: KIE
- Durable binary archive: Google Drive owner OAuth

Vercel is not production authority.

## Automatic release path

```text
PR
 -> GitHub CI
 -> merge to main
 -> CI on exact main SHA succeeds
 -> Deploy Production workflow_run
 -> resolve exact successful CI SHA
 -> SSH VPS
 -> scripts/deploy.sh <exact SHA>
 -> schema fence
 -> Drive OAuth precheck
 -> Docker build/up
 -> Caddy validate/reload
 -> app health + worker running
 -> media archive backfill
 -> record last-good / rollback candidate
```

Do not deploy a different SHA than the one that passed CI.

## What CI checks

Current `.github/workflows/ci.yml` covers:

- shell syntax for deploy/schema/Drive scripts;
- `scripts/check-schema-contract.sh`;
- `pnpm lint`;
- `pnpm typecheck`;
- `pnpm exec tsc -p tsconfig.worker.json`;
- durable worker Docker image build;
- `ffmpeg` and `ffprobe` runtime availability;
- full `pnpm test`;
- `pnpm build`.

Warnings may be visible without failing CI; errors/tests/build failures block merge/release according to normal PR discipline.

## Schema contract: migration-first is mandatory

Application deploy has a hard DB schema fence.

`supabase/schema-contract.txt` contains the schema version required by the checked-out application.

Before Docker restart, `scripts/deploy.sh` calls production RPC:

`orchestrator_get_deployment_schema_contract`

and compares:

```text
production DB schema_version
      ==
application supabase/schema-contract.txt
```

If versions differ, deployment exits before application code is started.

Therefore a PR that advances the schema contract must be released in this order:

1. migration file exists in Git;
2. migration is applied to production Supabase;
3. production RPC reports the new version;
4. application commit may deploy.

Do not «temporarily» weaken the fence to get a deploy through.

Current H3 schema fence after PR #92:

`20260822170000`

Migration:

`20260822170000_stage4_minimax_h3_primary_video.sql`

It registers `minimax-h3` through KIE, keeps Kling enabled and updates approved gameplay-video admission.

## GitHub Deploy Production workflow

`.github/workflows/deploy-production.yml` supports:

- automatic deploy after successful `CI` on `main`;
- manual `preflight`;
- manual `deploy`;
- manual `rollback`.

### Preflight

No provider generation is performed. It verifies:

- deploy host/user/key;
- candidate commit exists on server;
- candidate deploy scripts exist;
- production env exists;
- Supabase URL/server key configured;
- KIE API key configured;
- public HTTPS `APP_URL`;
- Google Drive owner OAuth credentials;
- archive root readability;
- current app health.

### Automatic deploy

Uses the exact `workflow_run.head_sha` that passed CI.

### Rollback

Uses `/srv/ai-factory/.deploy-rollback-candidate-commit` and deploys that exact recorded commit through the same deploy script. Do not manually patch files inside `/opt/ai-factory/app` as a rollback strategy.

## `scripts/deploy.sh`

High-level order:

1. resolve current checkout and rollback candidate;
2. fetch origin;
3. checkout exact target SHA detached;
4. validate checked-in schema contract;
5. load `/opt/ai-factory/.env`;
6. compare production DB schema contract;
7. force Google Drive runtime auth to `oauth_user`;
8. run live Drive OAuth/archive-root check;
9. build Docker images with `--pull`;
10. `docker compose up -d --remove-orphans`;
11. validate + reload Caddy;
12. verify worker/app access to shared assembly directories;
13. wait for app Docker health + core worker running;
14. run completed-media Drive archive backfill;
15. record new last-good SHA and previous rollback candidate.

On health failure the script prints recent app/worker logs and exits non-zero.

## Docker services

Current `docker-compose.yml`:

- `data-init`;
- `app`;
- `worker` — core queue, concurrency 1;
- `research-worker` — research queue, concurrency 5;
- `caddy`.

Both workers use the same built worker image but different `ORCHESTRATOR_QUEUE_MODE` and concurrency.

`BUILD_SHA=${DEPLOY_COMMIT}` is injected into worker runtime and written into `orchestrator_workers` heartbeat rows.

## Post-deploy acceptance

Minimum operational acceptance:

1. `/api/health` responds over production HTTPS;
2. newest `orchestrator_workers` core heartbeat is fresh;
3. newest research worker heartbeat is fresh;
4. both report exact expected `build_sha`;
5. `mock_workflows=false`;
6. production schema contract equals repo contract;
7. provider rows needed by the release are enabled;
8. no unexpected queue/retry explosion.

For H3 release specifically verify:

```text
provider_models.model = minimax-h3
provider = kie
enabled = true
parameters.provider_model = minimax/hailuo-03
parameters.primary_gameplay_video = true
parameters.default_duration_sec = 10
parameters.default_resolution = 768P
```

and `kling-3` remains `enabled=true`.

## Google Drive production requirement

Production deploy currently requires durable Drive archive to be configured and healthy.

Required operational class:

- `GOOGLE_DRIVE_INTEGRATION_ENABLED=true`;
- `GOOGLE_DRIVE_SHARED_FOLDER_ID`;
- `GOOGLE_DRIVE_CLIENT_ID`;
- `GOOGLE_DRIVE_CLIENT_SECRET`;
- `GOOGLE_DRIVE_REFRESH_TOKEN`.

Runtime auth is forced to `oauth_user` by Compose/deploy path.

## Caddy

Current Caddy host:

`battlestart-factory.duckdns.org`

Features:

- automatic HTTPS;
- gzip/zstd;
- request body max 20MB;
- SSE-friendly reverse proxy flushing;
- 10s dial timeout;
- 6m read/write timeout.

## Production environment safety

Never commit real secrets.

Public browser-safe variables are limited to intentional `NEXT_PUBLIC_*` values. KIE, Supabase server keys, Drive OAuth, B2 and webhook secrets remain server-side.

Canonical variable names: `.env.example`, `deploy/env.production.example`, `docs/environment-inventory.md`.

## Vercel

A legacy Vercel GitHub status may remain red. It does not determine VPS production health and should not be used to redesign current deployment.

If/when account access is available, remove the obsolete Vercel integration to reduce signal noise.

## Release checklist

- migration file committed if schema changes;
- production migration applied before schema-fenced app deploy;
- PR CI green;
- exact main SHA known;
- Deploy Production succeeds;
- schema RPC correct;
- app healthy;
- core + research worker heartbeats fresh and exact SHA;
- provider registry correct;
- Drive archive healthy;
- for paid-output changes: run a bounded explicit product acceptance, not an automatic expensive smoke.
