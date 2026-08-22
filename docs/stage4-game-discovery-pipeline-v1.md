# Stage 4 — Game Discovery Pipeline v1

> **HISTORICAL / SUPERSEDED DESIGN CONTRACT.**  
> This file is retained so old PRs, migrations and workflow terminology remain understandable. It is **not** the current production implementation.  
> Current source of truth: `docs/implementation-current.md`.  
> Current operational snapshot: `docs/current-project-state.md`.

## Why this document still exists

Stage 4 v1 established several architectural decisions that remain important:

- game ideas are product hypotheses; media is evidence;
- typed concept -> moment -> shot -> prompt -> media lineage;
- DB state authoritative, queue only wake-up;
- durable child image/video workflows;
- human-controlled concept/reference/video gates;
- deterministic prompt compilation and asset lineage;
- restart safety, idempotency and bounded provider spend.

Those principles survived. Many concrete v1 defaults did not.

## Original v1 shape

The initial design centered on:

```text
DiscoveryObjective
 -> Concept Explorer
 -> Diversity Guard
 -> Human Concept Gate
 -> Concept Pre-Evaluation
 -> Gameplay Moment Planner
 -> Shot / Prompt planning
 -> generated image/video evidence
 -> assembly
```

It introduced or formalized typed contracts such as:

- `DiscoveryObjectiveSpecV1`;
- `CoopGameConceptSpecV1`;
- `GameplayMomentSpecV1`;
- `ShotSpecV1`;
- `PromptPlanV1`;
- `AssetGraphV1`.

These types/compatibility shapes still appear in current code, but v3 may store a stronger human-facing conversational concept artifact and project it into legacy fields for downstream compatibility.

## Important current differences

Do **not** copy these old v1 defaults into new code.

| Old v1 design | Current production |
|---|---|
| `game_discovery_batch@1` default | `game_discovery_batch@3` default |
| 6 concepts / prototype top 2 | exactly 3 v3 conversational concepts; human selects |
| Sonnet/Haiku creative policy | KIE Gemini task policy downstream + GPT-5.6 Terra v3 strong concept synthesis |
| Human Gate then AI concept pre-eval | v3 Human Concept approval is authoritative; pre-eval edge skipped |
| one 5s video smoke | default 10s gameplay video |
| 9:16 gameplay source | **16:9 desktop PC gameplay source** |
| Nano Banana / GPT Image mix baseline | default **GPT Image 2** gameplay still |
| Kling 3 primary video baseline | **MiniMax H3 / Hailuo 03 primary**, Kling fallback |
| cinematic/readability guidance mostly prompt-level | typed Gameplay Authenticity + player-bound camera gates before spend |
| deterministic 9:16 short as core target | current assembly is evidence prototype; source gameplay remains 16:9 |
| no external research front-end | v3 starts with bounded verified KIE grounded research shared pool |

## Current Stage 4 downstream reuse

V3 deliberately reuses the mature Stage 4 evidence shell rather than cloning it:

```text
approved v3 concept
 -> GameplayMomentSpec
 -> ShotSpec + GameplayAuthenticitySpec
 -> purpose-aware Gameplay Reference Set
 -> deterministic PromptPlan
 -> GPT Image 2 still
 -> Human Image Gate
 -> GameplayVideoMotionPlan
 -> MiniMax H3 video
 -> Human Video Gate
 -> FFmpeg assembly + AssetGraph
```

The old typed schemas therefore remain useful compatibility contracts even though the front-end concept/research architecture changed.

## Human Gate lesson retained from v1

All current work must preserve:

1. Human Concept Gate;
2. Human Reference Image Gate before video spend;
3. Human Video Gate before assembly.

Generated media is not post-generation auto-rejected by AI.

## Historical source

The complete original v1 design remains available in Git history prior to the 2026-08-22 documentation consolidation. Use Git history when debugging a specific old PR/migration; do not restore historical defaults into current production without a new explicit product decision.