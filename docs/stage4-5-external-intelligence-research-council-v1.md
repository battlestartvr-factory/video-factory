# Stage 4.5 — External Intelligence & Research Council v1

> **HISTORICAL / VERSIONED V2 CONTRACT.**  
> This architecture was built as the `game_discovery_batch@2` generation of the factory and remains useful for compatibility/experiments. It is **not the current chat production default**.  
> Current implementation: `docs/implementation-current.md`.

## What this milestone introduced

Stage 4.5 solved a real gap in the original Stage 4 system: concepts needed current, source-backed external evidence rather than a closed-world creative loop.

It introduced durable primitives that remain valuable today:

- Research Policy / Research Plan;
- source/evidence/cache/provenance tables;
- Safe Fetch boundary;
- grounded source identities;
- external visual-reference semantics;
- bounded research budgets;
- durable research worker queue;
- explicit separation between fresh Research Memory and future strategic Stage 6 memory;
- versioned `game_discovery_batch@2`;
- evidence-linked concept generation;
- preservation of all three Stage 4 Human Gates.

## Original v2 target graph

```text
Discovery Objective
 -> Research Director
 -> 5 independent durable Research Scouts
      market_competitor
      mechanics
      player_voice
      gameplay_visual
      white_space_contrarian
 -> Research Memory
 -> one Synthesizer / Evidence Pack
 -> 3 Concept Council designers
 -> one Curator
 -> grounded concepts
 -> Human Concept Gate
 -> existing Stage 4 media pipeline
```

This graph is intentionally retained in code as a versioned workflow option; it is no longer the default architecture for new natural chat discovery runs.

## Why v3 simplified it

Production testing showed that `5 Scouts = 5 independent grounded searches` was unnecessarily fragile and costly:

- each Scout had its own source/provenance failure boundary;
- the same web/source family could fail repeatedly;
- coverage recovery was harder to control;
- more paid calls did not automatically mean better source diversity;
- Council/Curator fan-out added complexity before we had evidence that it improved human concept decisions.

V3 therefore kept the valuable research/provenance substrate while simplifying acquisition and concept synthesis.

## Current v3 replacement

```text
Discovery Objective
 -> shared bounded KIE grounded acquisition
 -> Safe Fetch + canonical/content identity gates
 -> coverage-aware targeted recovery
 -> one verified shared source pool
 -> compact Research Pack
 -> one strong GPT-5.6 Terra concept synthesis
 -> exactly 3 concepts
 -> Human Concept Gate
 -> existing Stage 4 downstream shell
```

Current shared-pool limits:

- max 10 accepted verified sources;
- min 4 verified sources;
- required competitor/mechanics/player_voice/gameplay_visual coverage;
- absolute max 6 KIE search/provider calls;
- Research Plan may lower cap;
- Safe Fetch concurrency 3.

The v2 Scout roles still exist in schemas/workflows for compatibility, but new v3 chat runs should not be interpreted as five independent Scout jobs.

## Principles that remain current

### Provenance

A model-written claim is not evidence unless source identity can be verified.

### Safe Fetch

Fetched pages are untrusted data. External content never becomes trusted system instruction.

### Bounded research

No recursive autonomous browsing or unbounded research loop.

### Research Memory is not Stage 6 memory

Fresh external evidence/cache does not automatically become long-term strategic learning.

### External visual references are not generated assets

Web images keep source provenance and do not auto-enter Gameplay Reference Library.

### Human Gates remain mandatory

Research intelligence cannot bypass:

1. Human Concept Gate;
2. Human Reference Image Gate;
3. Human Video Gate.

## KIE provider decision retained

The project chose to keep paid external research inside the existing KIE provider account rather than require a second search subscription.

Current v3 path still follows that decision:

- `KIE_API_KEY`;
- KIE Gemini Google Search grounding;
- default `gemini-3-6-flash`;
- optional `KIE_WEB_SEARCH_MODEL` override;
- factory performs Safe Fetch itself.

## Historical DB contracts

Stage 4.5 introduced research tables such as:

- `research_runs`;
- `research_queries`;
- `research_sources`;
- `research_run_sources`;
- `research_evidence`;
- `research_evidence_sources`;
- `research_assets`;
- `research_packs`.

These remain evidence/provenance storage. They are not an alternate orchestrator; `factory_jobs`/`creative_runs` remain authoritative.

## What not to restore accidentally

Do not re-enable the original Council graph as default solely because this document used to call it the target architecture.

A future experiment may compare v2 Council vs v3 strong-single-model synthesis, but it should be a controlled experiment with:

- same objective/research pack;
- explicit cost;
- human concept verdicts;
- diversity/quality metrics;
- no hidden production rollout.

The complete original Stage 4.5 contract remains available in Git history before the 2026-08-22 documentation consolidation.