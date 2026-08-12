# Factory Pipeline Runbook

Additive factory pipeline (`factory_*` tables) runs parallel to legacy `jobs` / `assets`. Legacy UI and `/api/jobs` remain unchanged.

## Local migration

Apply migrations in order via Supabase SQL Editor or CLI:

```bash
# Supabase CLI (if linked)
supabase db reset   # clean local only
# or apply single file:
supabase migration up
```

Manual order:

1. `supabase/migrations/20260311000000_initial_schema.sql`
2. `supabase/migrations/20260311000001_fix_profiles_rls.sql`
3. `supabase/migrations/20260311000002_restrict_client_writes.sql`
4. `supabase/migrations/20260812000000_factory_content_system.sql`

**Do not apply to remote production without explicit approval.**

## Type generation

This repo maintains hand-written types:

- Legacy: `lib/types/database.ts`
- Factory contracts: `lib/factory/contracts.ts`

If you adopt Supabase CLI typegen later:

```bash
supabase gen types typescript --local > lib/types/supabase.generated.ts
```

Do not hand-edit generated output.

## Tests

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Factory-specific unit tests live under `tests/unit/factory-*.test.ts`.

## provider_models

Use `docs/factory-provider-seed.sql` as a commented template. Fill `model` and `endpoint` from KIE documentation. Set `enabled = true` only after manual verification.

Example `projects.factory_settings` budget JSON:

```json
{
  "per_job_usd_limit": 5.0,
  "daily_usd_limit": 50.0
}
```

## RLS verification (two users)

1. Create User A and User B in Supabase Auth.
2. Create Project P owned by A; add A as `project_members` owner.
3. Create factory job for P via service role or `/api/factory/jobs` as A.
4. As User B (browser/anon client): `SELECT * FROM factory_jobs` → empty.
5. As User A: sees job via RLS.
6. As User A: direct `INSERT INTO factory_jobs` → permission denied (no write policy).

## Manual API smoke (no production n8n)

Set in `.env.local`:

```env
MOCK_WORKFLOWS=true
N8N_FACTORY_BASE_URL=
FACTORY_WEBHOOK_SECRET=
```

Create job:

```bash
curl -X POST http://localhost:3000/api/factory/jobs \
  -H "Content-Type: application/json" \
  -H "Cookie: <session-cookie>" \
  -d '{
    "projectId": "<uuid>",
    "jobType": "post",
    "preset": "balanced",
    "contentNamespace": "dev_reality",
    "prompt": "Test prompt"
  }'
```

Expected: `202` with `{ jobId, requestId, status, accepted }`.

Read job:

```bash
curl http://localhost:3000/api/factory/jobs/<jobId> \
  -H "Cookie: <session-cookie>"
```

## Environment variables

| Variable | Scope | Purpose |
|----------|-------|---------|
| `N8N_FACTORY_BASE_URL` | server | Base URL for factory n8n webhooks |
| `FACTORY_WEBHOOK_SECRET` | server | HMAC secret for `x-factory-signature` |

Never expose these as `NEXT_PUBLIC_*`.

## RPC functions (service_role only)

- `factory_create_or_get_job(payload jsonb)`
- `factory_claim_stage(job_id, stage, input)`
- `factory_record_event(...)`
- `factory_transition_job(...)`
- `factory_check_budget(job_id, capability, estimated_cost_usd)`

Called from n8n with service role credentials, not from browser.
