# Архитектура — current production state

> Canonical current-state companion: `docs/current-project-state.md`. Старые документы про Vercel/n8n-first MVP следует читать как историю миграции, а не как production topology.

## North Star

Система строится как autonomous experimentation and learning loop для поиска PC/Steam friends co-op игр. Контент — эксперимент; игровая идея — product candidate; human interest — evidence; durable memory должна делать следующие эксперименты лучше.

## Production topology

```text
Browser
  -> Caddy (VPS, HTTPS)
  -> Next.js app container
       -> Supabase PostgreSQL/Auth
       -> KIE/provider APIs
       -> Google Drive durable archive
       -> Backblaze B2 temporary ingest where required

Supabase pgmq/core_orchestrator_v1
  -> durable worker container
       -> workflow handlers
       -> provider submit/poll
       -> FFmpeg assembly
       -> Drive archive
       -> Supabase state/events/lineage

GitHub main -> CI -> Deploy Production -> SSH -> VPS Docker Compose
```

Public production host: `https://battlestart-factory.duckdns.org`.

## Durable orchestration invariants

1. **Database state is authoritative.** PGMQ delivery only wakes a job; it does not define workflow truth.
2. Every paid/provider operation has durable admission, lineage, state and terminal outcome.
3. Lease/heartbeat/watchdog recovery must remain restart-safe and idempotent.
4. Terminal `factory_jobs.status` is synchronized to its **root** `creative_runs.status` by `factory_jobs_sync_root_creative_run_terminal`; child concept/media runs are deliberately not bulk-mutated.
5. Human gates are explicit durable state, not UI-only buttons. Stage 4 currently has concept, reference-image and video approval/revise/reject paths.
6. Reject/revise evidence is retained and fed back into later generation/planning; reject must not be satisfied by a cosmetic reskin of the same mechanic.
7. Google Drive is the durable binary archive for Gameplay Reference and generated evidence. Supabase stores structured semantics, provenance and pointers.
8. No new subsystem should bypass `factory_jobs`/`creative_runs` lineage simply because a provider call is easy to make directly.

## Stage 4 canonical flow

```text
DiscoveryObjective
 -> Concept Explorer + Diversity Guard
 -> Human Concept Approval Gate
 -> Concept Pre-Evaluation
 -> Gameplay Moment Planner
 -> Gameplay Reference retrieval / purpose separation
 -> Gameplay Shot + Prompt planning
 -> Reference image generation
 -> Gameplay Authenticity inspection
 -> Human Reference Approval Gate
 -> Image-to-video generation
 -> Human Video Approval Gate
 -> deterministic prototype assembly + Drive archive
 -> root prototype_result + complete lineage
```

Known-good production batches and acceptance evidence are recorded in `docs/current-project-state.md`.

## Stage 4.5 additive intelligence boundary

Stage 4.5 adds a tactical external sensing layer **in front of** the known-good Stage 4 pipeline. It does not replace orchestration or any Human Gate.

Target v2 front-end flow:

```text
DiscoveryObjective
 -> Research Director
 -> 5 independent durable Research Scouts
 -> Research Memory
 -> one Evidence Pack synthesis
 -> 3 Concept Council members
 -> one Concept Curator
 -> Human Concept Approval Gate
 -> existing Stage 4 downstream flow unchanged
```

Research Memory is an evidence/cache/index layer. Its tables link back to `factory_jobs` and root `creative_runs`; they are not authoritative workflow state. Fresh research evidence does not automatically become Stage 6 `memory_items`.

Only the Research subsystem may later receive web search/fetch/image-search tools. Concept, Image and Video planners consume bounded typed evidence/reference inputs and do not browse directly.

The canonical contract is `docs/stage4-5-external-intelligence-research-council-v1.md`.

## Main domain/storage boundaries

- `creative_runs`: experiment/domain lineage.
- `factory_jobs`: durable execution state.
- `factory_workflow_events`: auditable transitions/wakeups.
- `generations`: image/video provider lineage.
- `gameplay_references`: structured real-gameplay reference library.
- `gameplay_*_reviews` + `gameplay_authenticity_inspections`: human/evaluator evidence.
- `research_runs` / `research_queries` / `research_sources` / `research_evidence` / `research_assets` / `research_packs`: Stage 4.5 fresh external evidence/cache/provenance; not an orchestration engine and not Stage 6 strategic memory.
- `lib/game-discovery/`: typed Stage 4 semantics; prompts are compiled artifacts, not the source of product truth.
- `lib/research-intelligence/`: typed Stage 4.5 research/evidence/reference contracts.

## What comes next

The immediate architecture milestone is the bounded Stage 4.5 External Intelligence & Research Council path. It must remain versioned/additive and preserve `game_discovery_batch@1` as the fallback while `game_discovery_batch@2` is built.

After Stage 4.5 closes, continue Stage 5/6:

`DISCOVERY -> EXPERIMENT -> EVALUATION -> HUMAN SIGNAL -> LEARNING -> SMARTER DISCOVERY`

Evaluation must distinguish concept/gameplay quality from artifact/provider defects; learning writes must be evidence-backed and reusable by future discovery batches.
