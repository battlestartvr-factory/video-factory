# Durable Factory Runbook

This runbook describes the current durable factory/orchestrator. The old n8n-first `jobs/assets` pipeline is legacy; new Game Discovery work must use the `factory_jobs` + `creative_runs` durable model.

## Read first

- `docs/current-project-state.md`
- `docs/architecture.md`
- `docs/stage4-game-discovery-pipeline-v1.md`
- `docs/stage4-economy-approval-feedback-policy.md`

## Core operational rule

**DB state is authoritative; queue messages are wake-up signals.** Never reconstruct workflow truth from queue delivery alone.

The worker claims a job with a lease, runs one workflow tick, commits state with the lease token, and acks the queue delivery. Heartbeats renew the lease; watchdog recovery re-enqueues due/stale work.

## Local checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

CI runs the same safety gate before production deployment.

## Root terminal-lineage invariant

Migration `20260820081126_stage4_root_creative_run_terminal_sync.sql` installs an `AFTER UPDATE OF status` trigger on `factory_jobs`.

When a job becomes `completed`, `failed` or `cancelled`, its non-terminal **root** `creative_run` (`parent_run_id IS NULL`) receives the same terminal status and `completed_at`. Child concept/media creative runs are not bulk-mutated.

Useful audit:

```sql
select count(*) as stale_root_terminal_mismatches
from creative_runs cr
join factory_jobs fj on fj.id = cr.factory_job_id
where cr.parent_run_id is null
  and fj.status in ('completed','failed','cancelled')
  and cr.status not in ('completed','failed','cancelled');
```

Expected: `0`.

## Gameplay Reference Library indexing

References are archived in Google Drive and represented by structured rows in `gameplay_references`. Image indexing is a durable workflow `gameplay_reference_index@1`; the vision captioner is currently `gemini-3-6-flash` through the configured provider path.

Current indexing is intentionally a one-provider-call caption/structure pass with deterministic normalization. Provider/schema failure is persisted as evidence; it does not silently auto-spend another model call.

Status audit:

```sql
select media_type, index_status, count(*)
from gameplay_references
group by media_type, index_status
order by media_type, index_status;
```

Enqueue pending image references through the existing service-role RPC, not by hand-building queue messages:

```sql
select reference_id, public.gameplay_reference_enqueue_index_v1(reference_id)
from gameplay_references
where media_type = 'image'
  and index_status = 'pending_caption';
```

If a failed caption is deliberately approved for a paid retry, first reset only that reviewed row to `pending_caption`, clear the attempt/error fields, then enqueue through the same RPC. Do not globally retry failures: a failure may contain paid evidence that should be repaired deterministically from `caption_debug.rawResponse` via the stored-caption repair path when possible.

The current worker reads `core_orchestrator_v1` one delivery at a time; large library backfills therefore complete progressively. Do not enqueue duplicate active index jobs for the same reference.

## Stage 4 human gates

The discovery worker must park at explicit durable stages until human evidence is present:

- `human_concept_approval_pending`
- `human_reference_approval_pending`
- `human_video_approval_pending`

`approve` advances the active branch. `revise` records feedback and creates a corrected branch/version according to the stage contract. `reject` is negative evidence; for concepts, replacement must be mechanically material, not a cosmetic reskin.

## Stage 4 finalization

A discovery batch can finalize only from human-approved video branches with matching prototype assemblies. The root run persists `prototype_result`; complete lineage remains queryable through child runs/generations/events/reviews.

Known-good run IDs and closeout evidence are in `docs/current-project-state.md`.

## Cost discipline

- Do not run image/video/provider smokes just to prove a code path if DB/code/CI evidence is sufficient.
- Paid acceptance tests must have a stated product question.
- Keep provider failure evidence; do not hide it by blind retry loops.
- Stage 5 should learn to distinguish concept failures from prompt/model/artifact failures.

## Production release

Merge/push to `main` only after CI succeeds for the exact commit. `Deploy Production` then SSH-deploys that commit to the VPS. The legacy Vercel status is not the production deploy gate.
