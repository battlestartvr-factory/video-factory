# Deployment — canonical production guide

## Production target

Primary production is **Ubuntu 26.04 VPS + Docker Engine/Compose + Caddy**.

- Public app: `https://battlestart-factory.duckdns.org`
- App checkout: `/opt/ai-factory/app`
- Production env: `/opt/ai-factory/.env` (never committed)
- Durable/scratch root: `/srv/ai-factory`
- Full Docker details: `docs/docker-deployment.md`

`docs/docker-deployment.md` contains migration-history wording about the old Vercel cutover. For current operational decisions, this file and `.github/workflows/deploy-production.yml` are authoritative: production deploys to the VPS.

## Deployment path

```text
push/merge to main
 -> GitHub Actions: CI
 -> lint + typecheck + unit tests + build
 -> if CI succeeds: Deploy Production
 -> SSH to VPS
 -> scripts/deploy.sh <exact commit SHA>
 -> Docker build/up + health verification
```

Never deploy a different commit than the SHA that passed CI.

## Supabase migrations

`supabase/migrations/` is the source-controlled migration history. Apply migrations in version order; do not maintain a second manual migration list in docs.

Production migrations may be applied through the authorized Supabase tooling during an explicit maintenance task, but the **same migration file must be committed to Git**. If production was migrated first, use exactly the production migration version/name in the repository to avoid drift.

Stage 4 closeout introduced:

- `20260820081126_stage4_root_creative_run_terminal_sync.sql`

It installs the root terminal-lineage invariant and backfills historical mismatches.

## Required environment classes

Canonical names live in `.env.example`, `deploy/env.production.example`, and `docs/environment-inventory.md`. Major groups:

- Supabase public + server-side credentials
- `KIE_API_KEY` / provider config
- `APP_URL` = public HTTPS production URL
- Google Drive OAuth/user archive credentials
- B2 ingest credentials where used
- worker/orchestrator tuning
- optional legacy n8n variables for code paths that still use them

Secrets must stay server-side and must never be committed or exposed as `NEXT_PUBLIC_*` unless they are intentionally public Supabase values.

## Production preflight / rollback

`.github/workflows/deploy-production.yml` supports manual `preflight`, `deploy`, and `rollback` modes. Preflight verifies the candidate commit, required env, Drive archive configuration and current app health without making provider requests.

Rollback deploys the recorded previous candidate commit; do not manually edit production files as a substitute for rollback.

## Vercel status

Vercel is no longer the production authority for this project. A legacy Vercel GitHub status can still appear as failed even when the VPS application and canonical GitHub CI/deploy are healthy. Do not block a VPS release solely on that legacy external check; remove/disable the external Vercel integration when account access is available.

## Release checklist

- CI green for exact commit SHA.
- Supabase migrations in Git and production are aligned.
- `Deploy Production` succeeded for that SHA.
- `/api/health` is healthy on the VPS.
- No unexpected non-terminal/expired durable jobs.
- For Game Discovery changes, verify lineage and human gates rather than only checking generated media.
