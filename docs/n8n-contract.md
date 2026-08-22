# n8n Contract — legacy generic content lane

> **LEGACY / NOT CURRENT GAME DISCOVERY ORCHESTRATION.**  
> The repository still contains generic `jobs/assets` and n8n-compatible code paths, so this contract is retained for compatibility. New Game Discovery v3 work must use the durable `factory_jobs` + `creative_runs` + worker/PGMQ architecture documented in `implementation-current.md`.

## What this contract was for

The original generic content-factory MVP used:

```text
Next.js -> signed n8n webhook
n8n -> external providers
n8n -> signed callback to Next.js
Next.js -> jobs/assets state
```

Related env variables still exist:

- `N8N_WEBHOOK_URL`;
- `N8N_WEBHOOK_SECRET`;
- `N8N_FACTORY_BASE_URL`;
- `FACTORY_WEBHOOK_SECRET`.

Do not provision or extend n8n merely to implement Game Discovery v3.

## Legacy outbound shape

Historical endpoint:

`POST {N8N_WEBHOOK_URL}`

Historical headers:

```text
Content-Type: application/json
X-Webhook-Timestamp: <unix>
X-Webhook-Signature: HMAC-SHA256(rawBody, N8N_WEBHOOK_SECRET)
Idempotency-Key: <eventId>
```

Typical body carried a generic `job.created` event with project/job/type/mode/source/callback fields.

## Legacy callback

Historical callback endpoint:

`POST /api/webhooks/n8n/job-update`

with the same HMAC scheme and `job.updated` state/progress/assets/usage/error payload.

The old generic status graph was:

```text
draft -> queued
queued -> processing | cancelled | failed
processing -> review | completed | cancelled | failed
review -> processing | completed | cancelled
failed -> queued (retry only)
completed/cancelled -> terminal
```

## Current Discovery difference

Current co-op Game Discovery does not depend on the n8n callback graph.

It uses:

```text
chat
 -> Universal Agent intent routing
 -> start_game_discovery
 -> factory_jobs / creative_runs
 -> PGMQ
 -> core/research workers
 -> durable workflow events
 -> KIE/Safe Fetch/media providers
 -> Human Gates
```

DB state is authoritative; queue delivery is only a wake-up.

## If maintaining a legacy n8n path

Preserve:

- HMAC verification;
- idempotency by `eventId`;
- server-side secrets only;
- safe terminal transitions;
- no secret leakage in callback errors.

Use the current production domain `https://battlestart-factory.duckdns.org` for any intentionally maintained callback configuration, not stale `*.vercel.app` examples.

## Future decision

If generic scripts/posts/dev-diary production is revived as a first-class product lane, decide separately whether to keep n8n or migrate it onto the durable worker substrate. Do not conflate that decision with the Game Discovery architecture.