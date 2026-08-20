# Current Project State / Agent Handoff

Last closeout update: **2026-08-20**.

This is the first document a new coding agent should read. It records current product intent and production facts; older design documents remain useful for contracts/history but can contain superseded deployment/status wording.

## 1. Product intent

North Star: an autonomous experimentation and learning system for discovering promising PC/Steam friends co-op games.

- content is the experiment;
- the game idea is the product candidate;
- human interest is evidence;
- prototype build is a promotion threshold;
- memory is where evidence compounds.

Do not optimize the repository as a generic content generator. Image/video generation is evidence production inside the discovery loop.

## 2. Stage status

- Stage 1–3: durable platform/orchestration foundation — DONE.
- **Stage 4: Game Discovery Pipeline — technical DONE.**
- Stage 5/6 are next: Gameplay Quality Evaluator + Learning/Memory Loop.
- Stage 7 external market/trend intelligence should be added after the internal evaluation/learning loop can use evidence correctly.

Stage 4 technical closure does **not** mean every future paid acceptance smoke must run now. The explicit deferred item is the paid Tilt Salvage authenticity regression; run it later when it answers a real regression/product question.

## 3. Stage 4 production evidence

Known-good complete batch:

- factory job: `20287124-5eb2-423d-9abb-4f2d179e3356`
- root creative run: `16cd334f-6d7b-4b63-bb88-469f1fffa3ca`
- terminal status: completed
- 6 concepts
- 2 gameplay video requests
- 2 prototype assemblies
- root `prototype_result` present

An earlier complete batch also reached concept -> media -> assembly end-to-end. Historical failed/cancelled attempts are evidence and must remain queryable.

## 4. Human Concept Approval Gate

The latest Stage 4 extension is a durable human concept gate before pre-evaluation/media generation.

Decisions: `approve | revise | reject`.

Critical contract: reject removes the active concept and requires a **mechanically new** replacement. Merely changing setting/art direction is not sufficient. Unit coverage lives in `tests/unit/human-concept-gate.test.ts`.

The same evidence-first philosophy applies to reference-image and video human gates.

## 5. Terminal lineage closeout fix

Production previously contained 7 historical root `creative_runs` left `running/queued` after their `factory_jobs` were already `failed/cancelled`.

Migration `20260820081126_stage4_root_creative_run_terminal_sync.sql`:

- installs an atomic trigger from terminal `factory_jobs.status` to non-terminal **root** `creative_runs.status`;
- deliberately excludes child creative runs;
- backfills historical mismatches.

Post-migration acceptance query must return `0` stale root terminal mismatches. See `docs/factory-runbook.md`.

## 6. Gameplay Reference Library

Seed library:

- 10 games
- 76 image references
- all 76 have durable Google Drive pointers
- structured schema captures camera, player-control evidence, co-op dependency, mechanics, readability, art/production cues, provenance and dedupe fields
- deterministic/perceptual dedupe and purpose-aware retrieval are implemented
- vector-ready HNSW/RPC primitive exists, but current v1 caption indexing does not populate embeddings; do not report vector semantic retrieval as active until embeddings are actually written

On 2026-08-20 the remaining 53 image references (52 pending + one reviewed failed empty response) were deliberately admitted to the existing durable indexing workflow. The failed empty-response row was explicitly reset for one paid retry. **Before claiming library closeout, verify the live counts below.**

```sql
select index_status, count(*)
from gameplay_references
where media_type = 'image'
group by index_status
order by index_status;
```

Closeout target: `indexed = 76`, with no `pending_caption`, `captioning` or `failed` rows.

## 7. Production / deployment

Primary production: `https://battlestart-factory.duckdns.org` on Ubuntu VPS + Docker Compose + Caddy.

Canonical release path:

`main -> GitHub CI -> Deploy Production -> SSH -> exact commit on VPS`.

A legacy Vercel GitHub check can show failure and is not authoritative for VPS production. Disable/remove that external integration when Vercel account access is available; do not redesign application code around it.

## 8. Non-negotiable engineering invariants

1. DB workflow state is authoritative; queue delivery is only a wake-up.
2. Preserve restart safety, leases, idempotency and event dedupe.
3. Keep objective -> concept -> moment -> shot -> generation -> human review -> assembly lineage intact.
4. Human feedback is evidence and must be stored before it is reused.
5. Do not let a prettier generated artifact conceal a weak game mechanic.
6. Do not silently broaden paid retries.
7. Drive stores durable binaries; Supabase stores structured facts/evidence/pointers.
8. New migrations applied to production must also exist in Git with matching version/name.

## 9. What the next agent should build

Prioritize Stage 5/6 as one product loop while keeping separate domain responsibilities:

```text
DISCOVERY
 -> EXPERIMENT
 -> EVALUATION
 -> HUMAN SIGNAL
 -> LEARNING
 -> SMARTER DISCOVERY
```

Evaluator dimensions should stay separable: game concept quality, co-op value, novelty, buildability, hook/readability, gameplay authenticity, and artifact/provider defects. A bad artifact should allow selective regeneration; a bad mechanic should kill or demote the concept branch.

Learning should turn evaluator findings + human `Love / Maybe / Reject` rationale + generation outcomes into atomic, evidence-backed reusable learnings. The key product metric is **Learning Lift**: whether later batches measurably improve because of accumulated evidence, rather than simply producing more random concepts.

## 10. Do not redo

Do not restart Stage 4 from scratch, replace durable orchestration with an ad-hoc agent loop, or add broad trend ingestion before Stage 5/6 can consume evidence. Use Stage 4 as the experiment-production substrate and move the intelligence frontier forward.
