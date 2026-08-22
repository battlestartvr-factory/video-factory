# Architecture — current production state

**Updated:** 2026-08-22  
Full implementation reference: `docs/implementation-current.md`.

## Product boundary

AI Co-op Game Discovery Factory — durable experimentation system для поиска и проверки PC/Steam co-op game ideas.

```text
DISCOVERY -> EVIDENCE PROTOTYPE -> HUMAN SIGNAL -> EVALUATION -> LEARNING
```

Current production закрывает Discovery + evidence prototype + Human Gates. Stage 5/6 evaluation/learning ещё впереди.

## Runtime topology

```text
Browser
  -> HTTPS / Caddy on Ubuntu VPS
  -> Next.js app container
       -> Supabase managed Postgres/Auth
       -> KIE APIs
       -> Google Drive durable archive
       -> Backblaze B2 temp ingest where needed
       -> internal app services used by workers

Supabase PGMQ
  -> core worker container, concurrency 1
  -> research worker container, concurrency 5
       -> durable workflow ticks
       -> provider submit/poll
       -> Safe Fetch / research
       -> FFmpeg assembly

/srv/ai-factory
  -> shared assembly staging/output

GitHub main
  -> CI exact SHA
  -> Deploy Production workflow
  -> SSH VPS
  -> schema fence
  -> Docker Compose exact SHA
```

Public production: `https://battlestart-factory.duckdns.org`.

## Durable orchestration

Authoritative state lives in Supabase.

Core entities:

- `factory_jobs` — execution state/lease/retry/cancellation;
- `creative_runs` — experiment and creative lineage;
- `factory_workflow_events` — durable event trail/progress/wakeups;
- PGMQ queues — delivery only;
- `generations` + provider task/accounting rows — paid media lifecycle;
- research/reference/review domain tables — evidence and Human Gate decisions.

Invariant:

> Queue delivery never becomes workflow truth. Worker must always re-read/claim durable DB state.

Worker lifecycle:

1. queue read;
2. atomic claim + lease token;
3. one workflow tick;
4. lease heartbeat;
5. durable transition;
6. ack;
7. watchdog recovery for due/stale work.

Stop/cancel is durable: root cancellation removes active lease, heartbeat observes loss and aborts in-flight work through `AbortSignal`. Cancelled lineage must not authorize new paid submits.

## Current workflow graph: `game_discovery_batch@3`

```text
Natural chat game-design request
 -> start_game_discovery
 -> DiscoveryObjective
 -> bounded shared external research
      KIE Gemini + Google grounding
      Safe Fetch
      source/provenance/coverage gates
 -> verified Research Pack
 -> GPT-5.6 Terra strong synthesis
 -> exactly 3 conversational concepts
 -> HUMAN CONCEPT GATE
 -> gameplay moment planning
 -> shot planning + deterministic gameplay authenticity
 -> purpose-aware Gameplay Reference Set
 -> deterministic image/H3 prompt compilation
 -> GPT Image 2 gameplay still
 -> HUMAN REFERENCE IMAGE GATE
 -> deterministic GameplayVideoMotionPlan + pre-video authenticity gate
 -> MiniMax H3 / Hailuo 03 through KIE
 -> HUMAN VIDEO GATE
 -> deterministic FFmpeg assembly
 -> asset graph + Drive archive
 -> prototype_result
```

### Compatibility workflows

- `game_discovery_batch@1` — legacy Stage 4 path;
- `game_discovery_batch@2` — Stage 4.5 Council architecture;
- `game_discovery_batch@3` — current default.

Do not infer current production from the mere presence of v1/v2 handlers.

## Research boundary

Current v3 production does **not** run five independent paid Scout searches.

`lib/research-intelligence/shared-source-pool.ts` owns bounded acquisition:

- one broad KIE grounded source acquisition;
- Safe Fetch selected pages;
- canonical/content dedupe;
- title/source identity verification;
- coverage classification;
- targeted recovery only for missing categories;
- hard provider-call cap;
- fail closed before concept/media spend if evidence quality is insufficient.

Required coverage: competitor, mechanics, player_voice, gameplay_visual.

Research pages are untrusted evidence. They never become system instructions. Downstream creative/media models do not browse them directly; they receive compact typed artifacts.

## Concept boundary

V3 uses one strong Concept LLM (`gpt-5-6-terra`) instead of the v2 Council/Curator fan-out.

Model-facing concept artifact is intentionally conversational:

`conceptId + title + contentMarkdown + sourceRefs`

Exactly 3 concepts are required. The full human-readable artifact is authoritative. A deterministic compatibility projection feeds older Stage 4 downstream schemas.

After Human Concept Gate, v3 skips legacy AI concept pre-evaluation. Human approval is authoritative.

## Gameplay planning boundary

Gameplay semantics stay provider-neutral until deterministic provider policy is applied.

```text
approved concept
 -> GameplayMomentSpec
 -> ShotSpec
 -> GameplayAuthenticitySpec
 -> GameplayVideoMotionPlan
 -> PromptPlan
 -> provider request
```

Camera is product semantics, not decoration. Allowed camera must be the actual player-visible/control-bound gameplay camera. Cinematic/broadcast/spectator intent is rejected before paid media.

Shot Planner cannot select the video provider. `normalizeGenerationPolicy()` enforces current factory policy:

- 16:9;
- GPT Image 2 still;
- MiniMax H3 video;
- image-to-video;
- current duration policy.

## Human Gate boundary

Three durable human gates:

1. concept;
2. generated reference image;
3. generated gameplay video.

All support approve/revise/reject.

Generated media is **not** post-generation auto-rejected by AI. Pre-generation authenticity checks may stop spend; after generation the artifact decision belongs to the human reviewer.

This boundary prevents an evaluator from silently replacing product judgment with aesthetic preference.

## Reference boundary

Gameplay Reference Library stores curated real-gameplay visual evidence. References are selected by purpose, not simply visual similarity.

Purpose firewall separates camera, interaction, co-op and art-direction influence. External research images do not automatically enter this library.

Durable binary original -> Google Drive. Structured semantics/provenance/index state -> Supabase.

## Media boundary

### Image

- default `gpt-image-2`;
- 16:9 gameplay still;
- keyframe/approval checkpoint;
- no video admission before Human Image Gate.

### Video

Primary:

- factory id `minimax-h3`;
- KIE model `minimax/hailuo-03`;
- 10s default;
- 768P default;
- image-to-video;
- audio off for discovery evidence.

Fallback:

- `kling-3` remains enabled.

Current H3 prompt compiler is provider-specific but product semantics remain typed. Oversized H3 prompt fails before paid submit instead of being chopped after compilation.

## Assembly boundary

FFmpeg runs on the durable VPS worker path, never in browser/Vercel Functions.

Assembly requires human-approved video whose lineage matches the current approved reference image and concept/moment/shot.

Current v1 assembly supports one evidence shot per concept. Multishot is a future feature and fails explicitly rather than silently assembling ambiguous inputs.

## Storage boundaries

### Supabase

Structured authoritative state:

- orchestration;
- creative lineage;
- research provenance/evidence;
- generation state;
- reference metadata;
- Human Gate decisions;
- usage/accounting;
- deployment schema contract.

### Google Drive

Durable binary archive:

- knowledge originals;
- curated Gameplay Reference originals;
- completed media/archive outputs.

Production deploy requires owner OAuth/archive root health.

### Backblaze B2

Temporary asset-ingest storage for the ingest path. It is not the discovery system's durable semantic memory.

### VPS filesystem

Shared assembly staging/output only. Product truth must not exist solely there.

## Release architecture

CI exact commit checks:

- schema contract script;
- lint;
- app typecheck;
- worker TypeScript compile;
- worker Docker image;
- FFmpeg runtime;
- full unit tests;
- Next production build.

`Deploy Production` runs only after successful CI on `main` (or explicit manual action).

`scripts/deploy.sh` compares application schema fence with production DB RPC **before** application deployment. DB drift blocks release.

Then deployment verifies Drive OAuth, Docker services, Caddy config, shared workspace, app health and worker running state. Acceptance should verify `orchestrator_workers.build_sha` equals the exact merged commit.

## Architectural regressions to reject

- Vercel becomes production authority again without explicit migration decision;
- n8n becomes owner of current discovery workflow state;
- queue payload becomes authoritative state;
- provider call bypasses generation/job lineage;
- paid video is admitted without Human Image Gate;
- AI silently rejects generated media after generation;
- ungrounded web prose is accepted as evidence;
- external page content is treated as trusted instruction;
- creative LLM selects provider policy;
- H3 prompt is blindly truncated;
- cinematic camera replaces real gameplay camera;
- production application deploys against older DB schema.

Future architecture belongs in `docs/future-roadmap.md`, not in this current-state document.