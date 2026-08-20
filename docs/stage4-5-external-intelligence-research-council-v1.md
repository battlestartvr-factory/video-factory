# Stage 4.5 — External Intelligence & Research Council v1

Status: implementation contract. Started 2026-08-20.

This milestone adds a **bounded on-demand external research layer** before the existing Stage 4 concept/media pipeline. It is deliberately narrower than Stage 7 Market Intelligence: no always-on monitoring, broad social listening, recursive research, or automatic durable learning writes.

## Product reason

Stage 4 can already execute objective -> concepts -> gameplay moments -> generated evidence -> three Human Gates -> assembly. Stage 4.5 addresses the remaining information-closure problem: concept generation and reference planning should be grounded in current, source-backed external evidence without making the web or autonomous agents the workflow owner.

North Star remains unchanged: improve the probability of discovering and validating a real PC/Steam friends co-op game idea.

## Non-negotiable compatibility boundary

Stage 4 production is the known-good substrate.

- `game_discovery_batch@1` behavior remains available and unchanged.
- Stage 4.5 is introduced through versioned contracts and later `game_discovery_batch@2`.
- `factory_jobs` and `creative_runs` remain authoritative execution/lineage owners.
- queue delivery remains a wake-up, not workflow truth.
- restart safety, leases, idempotency, event dedupe, provider admission and cost lineage remain intact.
- external research cannot bypass existing human-controlled media decisions.

### Three Human Gates that must survive unchanged

1. **Human Concept Approval Gate** — final concepts do not proceed to pre-evaluation/media until a human decision exists.
2. **Human Reference Image Approval Gate** — generated reference/keyframe evidence must be approved before video admission.
3. **Human Video Approval Gate** — generated gameplay video must be approved before assembly/finalization.

All remain durable `approve | revise | reject` states. Concept reject still requires a mechanically new replacement rather than a cosmetic reskin. AI inspection cannot silently reject generated images/videos on behalf of the human.

## Target v1 intelligence flow

```text
DiscoveryObjectiveSpec
  -> Research Policy / Research Director
  -> durable fan-out: 5 independent Research Scouts
       market_competitor
       mechanics
       player_voice
       gameplay_visual
       white_space_contrarian
  -> Research Memory
  -> one Research Synthesizer / Battle
  -> Evidence Pack
  -> durable fan-out: 3 Concept Council designers
       mechanics explorer
       social/viral designer
       buildable systems designer
  -> one Concept Critic / Curator
  -> 6 grounded concept cards
  -> EXISTING Human Concept Approval Gate
  -> EXISTING Stage 4 downstream pipeline
  -> EXISTING Human Reference Image Approval Gate
  -> EXISTING Human Video Approval Gate
  -> assembly
```

There is exactly **one independent research round + one synthesis call** and exactly **one concept generation round + one curator call** in v1.

## Web/tool boundary

Only the Research subsystem may receive text-search, page-fetch or image-search capabilities.

Downstream Concept/Image/Video agents receive typed Evidence Packs and selected references. They do not browse directly.

Fetched pages are untrusted data. Search/fetch implementation must later enforce HTTP(S)-only access, SSRF protection, bounded redirects/response size/MIME/timeouts, boilerplate stripping, bounded relevant excerpts, no secret/cookie forwarding, and explicit prompt-injection separation.

## Typed contracts introduced in PR1

`lib/research-intelligence/schemas.ts` contains the versioned/domain contracts for:

- `ResearchPolicySpecV1`
- `ResearchScoutAssignmentSpecV1`
- `ResearchPlanSpecV1`
- `ResearchEvidenceSpecV1`
- `ResearchScoutReportSpecV1`
- `EvidencePackSpecV1`
- `ExternalVisualReferenceSpecV1`
- `ImageReferenceSetSpecV1`
- `CoopGameConceptResearchContextV1`

Stable Scout role IDs are:

- `market_competitor`
- `mechanics`
- `player_voice`
- `gameplay_visual`
- `white_space_contrarian`

Default smart-build `ResearchPolicy` is `mode=required`, `freshness=mixed`, external image references allowed, Gameplay Reference Library promotion disabled unless explicitly permitted.

## Hard v1 budgets

The Research Director cannot enlarge these by model choice:

- total search queries: max 20;
- fetched unique text sources: max 30;
- image candidates before dedupe/selection: max 24;
- Scout search queries: max 4 each;
- Scout fetched sources: max 6 each;
- structured evidence items: max 10 each;
- Scout image candidates: max 8 each;
- one Scout model call each;
- one research round; no autonomous follow-up council round.

Any future increase is an explicit config/product decision.

## Research Memory / DB boundary

Migration `20260820133000_stage4_5_research_intelligence_contracts.sql` adds an evidence/cache layer:

- `research_runs`
- `research_queries`
- `research_sources`
- `research_run_sources`
- `research_evidence`
- `research_evidence_sources`
- `research_assets`
- `research_packs`

The extra `research_evidence_sources` join table is an implementation detail that gives multi-source claims referential provenance instead of keeping unchecked source IDs only inside JSON.

These tables are **not an alternate orchestrator**. `research_runs.factory_job_id` and `root_creative_run_id` link research back to the existing durable job/creative lineage.

Research Memory is also **not Stage 6 memory**. A fresh web finding does not write `memory_items` automatically. Stage 6 later decides which repeated/evidence-backed insights deserve durable promotion.

PR1 keeps research tables service-owned (RLS enabled, direct anonymous/authenticated writes revoked). Explicit UI read surfaces arrive later with observability work.

## Source, evidence and visual-reference semantics

- `research_sources`: canonical URLs, content hashes, timestamps, bounded extracted text/pointers and cache metadata.
- `research_evidence`: atomic claims with source provenance, confidence, freshness and observed time.
- one URL found by multiple Scouts is not independent confirmation.
- external images are `research_assets` / `ExternalVisualReferenceSpec`, never generated assets.
- exact/perceptual hashes support visual dedupe.
- selected external images may later enter `ImageReferenceSetSpec` only after validation, provenance and selection.
- selected provider requests must preserve exact reference IDs in generation lineage.
- external web images never auto-enter the curated Gameplay Reference Library; explicit promotion is a separate controlled path for genuine gameplay evidence.

## Evidence Pack semantics

The Synthesizer sees compact Scout reports + atomic evidence, not full pages. It dedupes claims, exposes contradictions, distinguishes observation from inference, lowers confidence when evidence conflicts, identifies saturation/white-space/counterexamples and selects useful reference patterns.

It does **not** generate final game concepts.

The Concept Council receives objective + project constraints + bounded Evidence Pack + novelty history. Final concept cards must carry supporting evidence IDs, closest analogs, intentional differences, white-space rationale, confidence and `mustNotCopy` constraints.

## Failure policy for later PRs

- technical search timeout: normal durable technical retry; not a new research round;
- one Scout terminal failure: synthesize only if explicit coverage threshold is still satisfied and mark the missing role;
- two or more critical role failures: stop/park before expensive media;
- blocked source: retain search/error metadata; do not bypass site protections;
- invalid image candidate: reject that reference, not the whole batch;
- invalid Synthesizer schema: persist raw response/usage and use deterministic repair when possible; blind paid retry is off by default;
- no useful evidence: `required` stops before concepts; `best_effort` may explicitly fall back to Stage 4 baseline with low coverage recorded.

## Implementation PR sequence

1. **Contracts + DB** — schemas, ResearchPolicy, research tables/indexes, tests, docs. No provider calls and no Stage 4 runtime changes.
2. **Search/Fetch Layer** — provider-neutral text/image search, safe fetch, normalization, cache and injection boundary with mock tests.
3. **Research Scout workflow** — Director + `external_research_scout@1`, durable fan-out/fan-in, research worker concurrency.
4. **Research Synthesis** — evidence persistence/dedupe/freshness/confidence and Evidence Pack.
5. **Concept Council** — 3 parallel designers + Curator, evidence-linked final concepts, Diversity Guard integration.
6. **Web Visual References** — image search/fetch/archive/dedupe, external reference contracts and provider compilation.
7. **Game Discovery v2** — `game_discovery_batch@2`, then re-enter the existing Stage 4 Human Gate/downstream path.
8. **UI + production acceptance** — research timeline/pack/grounding/reference observability and one bounded real acceptance batch.

## PR1 acceptance boundary

PR1 is complete when:

- typed schemas validate the bounded v1 contracts;
- DB migration is additive and does not alter `factory_jobs`, `creative_runs`, PGMQ or current Stage 4 workflow states;
- source/evidence/image dedupe and provenance primitives exist;
- Research Memory cannot silently become Stage 6 memory;
- all three existing Human Gates remain present in the current v1 workflow and existing Stage 4 tests continue to pass;
- no real search/provider calls are introduced.

The next implementation step after PR1 is the provider-neutral safe Search/Fetch Layer with mocks first.

## Provider decision before PR8 — KIE-only external research

Decision recorded 2026-08-20: keep the paid external-intelligence path inside the existing KIE account/API key instead of adding a second search subscription.

Production research target:

```text
KIE Gemini 3.6 Flash + Google Search grounding
  -> exact grounded source-page URLs and grounded claim spans
  -> existing Stage 4.5 Safe Fetch boundary
  -> typed ResearchEvidence / Research Memory

For visual research:
KIE Google-grounded source pages
  -> bounded extraction of og:image / twitter:image / page <img> candidates
  -> existing safe image fetch + MIME/dimension/hash checks
  -> existing PR6 dedupe/archive/provenance/reference-selection path
```

Rules:

- KIE is the only paid search/model provider required by this path; page/image HTTP fetches are performed by the factory itself.
- `KIE_API_KEY` is reused; no second `WEB_SEARCH_API_KEY` is required for the KIE-only path.
- default research model is `gemini-3-6-flash`, configurable with `KIE_WEB_SEARCH_MODEL` for controlled rollback/experiments.
- a text result is accepted only when KIE returns Google grounding source URLs; prose without grounding fails closed.
- each production Scout performs one bounded KIE grounded-search/model call, then safe-fetches only the selected grounded pages. This preserves the one-model-call-per-Scout v1 budget.
- image discovery does not pretend KIE exposes a separate image-search API. It intentionally discovers real image candidates from KIE-grounded source pages and preserves the source-page URL as provenance.
- actual image bytes still pass PR2/PR6 safety and validation before becoming an `ExternalVisualReference`.
- source-page images never become generated assets and never auto-enter the Gameplay Reference Library.
- the KIE production Scout path is explicitly enabled with `WEB_SEARCH_PROVIDER=kie`; it is not silently activated by merely having a KIE key.
- `game_discovery_batch@1` remains the production default until PR8 acceptance; all three Human Gates remain unchanged.

Public capability evidence used for this provider decision:

- KIE Gemini 3.5/3.6 surfaces expose Google Search grounding; KIE uses Gemini-compatible model endpoints for grounded generation.
- Google lists Gemini 3.6 Flash among models supporting Google Search grounding/search-as-a-tool.

A live bounded KIE acceptance request is still required before PR8 flips any production default.
