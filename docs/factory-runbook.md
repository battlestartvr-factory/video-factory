# Durable Factory Runbook

**Updated:** 2026-08-22  
Current implementation: `docs/implementation-current.md`.

## Read first

1. `docs/implementation-current.md`
2. `docs/current-project-state.md`
3. `docs/architecture.md`
4. `docs/deployment.md`
5. relevant historical contract only when debugging legacy v1/v2 behavior

## Core rule

> **DB state is authoritative; queue delivery is a wake-up signal.**

Never repair production by inventing queue messages that bypass the DB admission/RPC contract.

## Basic local/CI checks

```bash
pnpm lint
pnpm typecheck
pnpm exec tsc -p tsconfig.worker.json
pnpm test
pnpm build
```

For worker/media changes also rely on CI's worker Docker + FFmpeg checks.

## Workflow version check

Current chat default should create:

`game_discovery_batch@3`

V1/V2 remain registered; seeing their code is not evidence that current chat uses them.

For a new discovery root inspect:

- `factory_jobs.workflow_kind` / `workflow_version`;
- root `creative_runs.metadata`;
- objective metadata `workflowVersion=3`;
- user-facing `/discovery` root lineage.

## Research shared-pool triage

V3 research source acquisition should remain bounded.

Expected production characteristics:

- KIE Gemini Google grounding;
- search model default `gemini-3-6-flash`;
- required verified categories: competitor, mechanics, player_voice, gameplay_visual;
- min 4 verified sources;
- max 10 accepted pool sources;
- provider-call cap <= 6;
- Safe Fetch concurrency 3.

Useful evidence is in research run/source/evidence/pack tables plus workflow progress events.

### Do not fix research failures by

- disabling provenance requirement;
- accepting Google grounding redirect URLs as final sources;
- bypassing Safe Fetch;
- removing minimum coverage;
- increasing calls without an explicit budget decision;
- retrying every category blindly.

### Common source rejection classes

- HTTP/Safe Fetch failure;
- duplicate canonical URL;
- duplicate content hash;
- title/source identity mismatch;
- source does not satisfy claimed category;
- blocked player community page.

Reddit is currently excluded from player_voice acquisition because production Safe Fetch receives 403. This is an explicit current limitation, not a reason to fake player evidence with editorial sources.

## Research progress / live trace

Trace is for observability, not workflow truth.

Look for events such as:

- source-pool search started/completed;
- source accepted/rejected;
- coverage recovery;
- verified coverage summary;
- source pool ready;
- provider calls/cap;
- search/Safe Fetch timing.

If UI trace stops but DB job is still live, inspect worker heartbeat/job lease/events rather than assuming the workflow is dead.

## Stop / cancellation

Cancellation must be durable and cost-safe.

Check:

1. root/child job cancellation state;
2. active lease cleared/revoked;
3. worker heartbeat still healthy;
4. no new provider submit after cancellation time;
5. retries do not resurrect cancelled lineage.

Worker lease heartbeat is intentionally short and acts as an abort fence. Do not add a second aggressive polling loop unless the existing mechanism proves insufficient.

## Human Concept Gate

Current v3 stage:

`human_concept_approval_pending`

Decisions: approve/revise/reject.

V3 approved concepts proceed to gameplay moment planning without legacy AI concept pre-evaluation. If a new v3 run unexpectedly enters AI pre-evaluation after the Human Gate, treat it as regression.

Concept revise/reject evidence must remain durable. Do not overwrite old revisions/history.

## Gameplay Moment / Shot sanity checks

Current default chat objective should carry:

- `workflowVersion=3`;
- `gameplayDurationSec=10`;
- `preferredImageModel=gpt-image-2`;
- `preferredVideoModel=minimax-h3`.

Shot generation plan should end up:

- `aspectRatio=16:9`;
- `keyframeRequired=true`;
- `imageModel=gpt-image-2` unless explicit approved objective override;
- `videoModel=minimax-h3`;
- `videoMode=image-to-video`;
- `durationSec=10` for default chat path.

A creative LLM returning Kling/5s should be normalized by factory policy. If persisted active ShotSpec still shows stale provider policy, investigate the launcher/planner normalization path before spending on media.

## Gameplay authenticity pre-generation gate

Before image/video provider calls verify:

- controllable player obvious;
- camera physically attached/player-visible;
- visible player input;
- causal player action -> world response;
- meaningful affordance;
- co-op dependency visible;
- physics state consistent;
- required visual evidence covered.

A failure here should block spend and record explicit gate defects/cost avoided.

## Gameplay Reference Library

Known-good closeout:

```text
image references = 76
indexed = 76
failed = 0
pending_caption = 0
captioning = 0
```

Status audit:

```sql
select media_type, index_status, count(*)
from gameplay_references
group by media_type, index_status
order by media_type, index_status;
```

Caption provider policy is one paid call per reference attempt. Stored raw caption repair is not a paid retry.

### Stored-caption repair rule

If `caption_debug.rawResponse` contains usable provider evidence and failure is deterministic schema drift:

- leave row `failed` for the repair path;
- do not reset to `pending_caption` merely to enqueue;
- do not claim a new paid caption permit;
- enqueue a new durable index job only after confirming no active one exists;
- verify `caption_usage.modelCalls` does not increase.

Only an explicitly reviewed unrecoverable row should be reset for a deliberate new paid caption attempt.

## Human Reference Image Gate

Stage:

`human_reference_approval_pending`

No approved image -> no video submit.

Partial review set remains parked until every active image has a decision. `revise` should not advance the batch while other cards are undecided.

Generated still is human-controlled evidence; no post-generation AI veto.

## H3 provider check

Production provider registry should include:

```sql
select
  model,
  provider,
  enabled,
  priority,
  parameters->>'provider_model' as provider_model,
  parameters->>'primary_gameplay_video' as primary_gameplay_video,
  parameters->>'default_duration_sec' as default_duration_sec,
  parameters->>'default_resolution' as default_resolution
from provider_models
where provider = 'kie'
  and capability = 'video'
  and model in ('minimax-h3','kling-3')
order by priority;
```

Expected current policy:

- `minimax-h3`: enabled, primary, `minimax/hailuo-03`, default 10, 768P;
- `kling-3`: enabled fallback/baseline.

## H3 prompt sanity

Compiler metadata should show:

- `compiler_version=gameplay_prompt_compiler_v7_h3`;
- `video_prompt_profile=minimax_h3_gameplay_i2v_v1`;
- provider model `minimax-h3`;
- prompt length <= 4800 chars;
- gameplay/video authenticity gates passed.

Prompt should preserve frame-0 and player-bound camera. If oversized, it should fail before KIE submit. Do not reintroduce post-hoc truncation.

## Video admission

Before `generation_video@1` submit:

- Human Image Gate passed;
- approved reference generation belongs to active shot;
- prompt exists;
- H3 duration valid;
- start frame URL exists;
- generation/provider permit/accounting fences pass.

If no image is approved, the branch should finish without video spend.

## Human Video Gate

Stage:

`human_video_approval_pending`

Decisions approve/revise/reject.

No automatic AI rejection after H3 generation. Human `revise` may create a new revision and therefore a new paid request; this is intentional human-authorized spend, not blind retry.

## Assembly

Assembly starts only from human-approved videos.

Validate lineage:

```text
approved video
 -> current approved reference generation
 -> same shot
 -> same moment
 -> same concept run
```

Current v1 assembly allows one evidence shot per concept. More than one approved video for the same concept should fail with an explicit multishot-not-supported contract instead of guessing assembly order.

FFmpeg runs in worker container. Assembly result and asset graph are persisted, then root finalization writes `prototype_result`.

## Root terminal-lineage audit

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

Historical failed/cancelled rows are not cleanup garbage; keep them as evidence.

## Worker health / exact release acceptance

```sql
select
  worker_id,
  build_sha,
  started_at,
  last_heartbeat_at,
  metadata->>'queue_mode' as queue_mode,
  metadata->>'mock_workflows' as mock_workflows
from orchestrator_workers
order by last_heartbeat_at desc
limit 10;
```

After deploy expect fresh core + research rows on exact release SHA and `mock_workflows=false`.

Old worker rows remain historical; compare timestamps, not just the presence of an older SHA.

## Schema contract

Before application release:

```sql
select schema_version, updated_at
from deployment_schema_contract;
```

Must match `supabase/schema-contract.txt`.

Do not bypass the deploy fence if it differs. Apply the committed migration first.

## Cost discipline

- no media smoke without a product question;
- no blind paid retry after schema/provenance failure;
- preserve provider usage/error evidence;
- track provider call count and cap;
- measure **cost per accepted gameplay shot**;
- distinguish human revision spend from technical retry spend;
- keep Kling fallback available without automatic provider hopping on content rejection.

## Real H3 acceptance checklist

For the next controlled real 10s run record:

- root job/run IDs;
- objective duration/provider metadata;
- approved still generation ID;
- H3 video generation ID;
- provider payload model/duration/resolution;
- video prompt compiler/version/chars;
- first-pass Human Video verdict;
- visible camera/action/physics/co-op issues;
- provider usage/cost if available;
- whether a revision was needed.

This is a quality acceptance, not a proof that the code path exists.

## Production release

Use `docs/deployment.md`. Minimum acceptance:

- exact CI SHA green;
- DB schema already aligned;
- Deploy Production success;
- public health green;
- exact core/research worker heartbeat;
- provider registry expected;
- Drive archive healthy.

Legacy Vercel status is not the production release gate.