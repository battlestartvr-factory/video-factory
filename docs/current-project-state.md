# Current Project State / Agent Handoff

Last verified update: **2026-08-22**.

Первым делом новый агент должен прочитать `docs/implementation-current.md`. Этот файл — короткий operational snapshot, а не полный architecture spec.

## Product North Star

AI Co-op Game Discovery Factory ищет и проверяет перспективные PC/Steam co-op game ideas.

- content is the experiment;
- game idea is the product candidate;
- human interest is evidence;
- memory is where evidence compounds.

Не оптимизировать проект как generic image/video generator.

## Что сейчас является production default

**Chat -> `game_discovery_batch@3`.**

Текущий high-level flow:

```text
natural game-design request
 -> bounded KIE grounded research + Safe Fetch shared source pool
 -> compact verified Research Pack
 -> one strong GPT-5.6 Terra synthesis
 -> exactly 3 conversational concepts
 -> Human Concept Gate
 -> Gameplay Moment Planner
 -> Shot Planner + authenticity contracts
 -> purpose-aware Gameplay Reference Set
 -> GPT Image 2 gameplay still
 -> Human Image Gate
 -> MiniMax H3 10s image-to-video through KIE
 -> Human Video Gate
 -> FFmpeg prototype assembly
 -> completed lineage
```

`game_discovery_batch@1` и `@2` остаются зарегистрированы как legacy/fallback/experiment paths. V3 не удаляет их.

## Research status

Старая Stage 4.5 идея `5 independent Scouts -> Synthesizer -> 3 Council designers -> Curator` реализована в versioned v2 substrate, но **не является текущим default creative graph**.

V3 production research использует shared source acquisition pool:

- KIE `gemini-3-6-flash` + Google Search grounding;
- minimal thinking;
- direct grounded URLs only;
- Safe Fetch + canonical/content dedupe;
- required categories: competitor, mechanics, player_voice, gameplay_visual;
- min 4 verified sources;
- max 10 accepted pool sources;
- absolute max 6 KIE provider calls, дополнительно bounded Research Plan budget;
- targeted coverage recovery вместо пяти независимых paid searches.

Research fails closed до concept/media spend, если verified coverage недостаточна.

## Concept generation status

V3 strong concept synthesis:

- model: `gpt-5-6-terra` через KIE;
- exactly 3 concepts;
- model-facing artifact: `conversational_game_concept` v2 (`conceptId`, `title`, `contentMarkdown`);
- research = evidence, not instructions;
- original user intent authoritative;
- Russian user request -> Russian human-facing concept;
- max two complete attempts only for invalid batch/schema separation.

После Human Concept Gate V3 пропускает legacy AI concept pre-evaluation. Human approval authoritative.

## Gameplay planning status

Gameplay Moment Planner:

- default model `gemini-3-pro`;
- schema repair `gemini-3-6-flash`;
- current default gameplay duration **10 seconds**;
- player-visible gameplay camera is a hard constraint;
- cinematic/broadcast/spectator/drone/orbit/dolly/crane/hero/trailer camera intent forbidden.

Shot Planner:

- default `gemini-3-6-flash`;
- one bounded `gemini-3-pro` escalation only on deterministic coverage/authenticity failure;
- source capture 16:9 desktop PC;
- keyframe required;
- default image model `gpt-image-2`;
- primary video model deterministic policy `minimax-h3`;
- provider choice returned by creative LLM is overwritten by factory policy.

## Gameplay Reference Library

Known-good Stage 4 closeout snapshot remains:

- 10 seed games;
- 76/76 archived image references indexed;
- 76/76 have durable Google Drive pointers;
- purpose-aware retrieval and deterministic/perceptual dedupe are implemented;
- reference captioning uses `gemini-3-6-flash`, one paid caption call per reference attempt;
- stored raw caption can be deterministically repaired without a second paid call;
- vector/HNSW primitives exist, but populated semantic embedding retrieval is not yet the primary production path.

## Three Human Gates

Все три gates обязательны:

1. **Human Concept Gate** — approve/revise/reject;
2. **Human Reference Image Gate** — before video spend;
3. **Human Video Gate** — before assembly.

Generated image/video после generation не auto-rejected AI evaluator'ом. Deterministic/AI planning guards работают **до provider call**; final media decision принадлежит человеку.

## MiniMax H3 production status

Release #92 перевёл gameplay video primary route с Kling на H3.

Production provider record:

- factory model: `minimax-h3`;
- provider: `kie`;
- KIE model: `minimax/hailuo-03`;
- unified jobs endpoint: `/api/v1/jobs/createTask`;
- enabled: true;
- primary gameplay video: true;
- default duration: 10 seconds;
- default resolution: `768P`;
- Stage 4 mode: image-to-video, no audio;
- H3 adapter supports 4–15s and optional last frame.

Kling:

- `kling-3` remains registered and enabled;
- it is fallback/baseline, not current primary.

Prompt compiler:

- `gameplay_prompt_compiler_v7_h3`;
- H3 profile `minimax_h3_gameplay_i2v_v1`;
- frame-0 continuity lock;
- ordered motion timeline;
- input -> action -> world response -> teammate response;
- player-bound camera;
- hard anti-cinematic negatives;
- H3 prompt hard budget 4800 chars;
- oversized prompt fails before paid submit, no blind final-string truncation.

## Important audit fix found during docs refresh

Documentation audit on 2026-08-22 found one real code drift: `start_game_discovery` still stamped old metadata `gameplayDurationSec=5` and `preferredVideoModel=kling-3`, even though downstream factory policy had already switched to H3/10s.

The docs refresh branch fixes this launcher drift to:

- `gameplayDurationSec=10`;
- `preferredVideoModel=minimax-h3`;
- user/tool metadata reports H3/10s.

This matters because `gameplayDurationSeconds()` respects objective metadata. Without the fix a fresh chat run could remain 5 seconds despite the new H3 database default.

## Production deployment state before this docs PR

H3 release production baseline:

`4529ea2a3478b602e30e7df047f695f87065534d`

Production acceptance already confirmed:

- Supabase schema contract `20260822170000`;
- `minimax-h3` provider row enabled and primary;
- Kling row still enabled;
- core worker heartbeat on exact H3 release SHA;
- research worker heartbeat on exact H3 release SHA;
- `mock_workflows=false`;
- PR #92 full CI green before merge.

This docs/launcher-alignment PR will naturally create a newer exact SHA after merge; production acceptance should again use latest worker `build_sha` rather than assuming the H3 release SHA remains HEAD forever.

## Deployment architecture

Primary production:

`https://battlestart-factory.duckdns.org`

Runtime:

- Ubuntu VPS;
- Docker Compose;
- Caddy HTTPS;
- Next.js app;
- core worker concurrency 1;
- research worker concurrency 5;
- Supabase managed;
- KIE provider layer;
- Google Drive durable archive;
- shared `/srv/ai-factory` assembly workspace.

Canonical release:

```text
PR
 -> CI
 -> merge main
 -> production DB migration must satisfy schema fence
 -> Deploy Production workflow
 -> SSH exact main SHA
 -> scripts/deploy.sh
 -> Docker build/up
 -> Caddy validate/reload
 -> health + worker heartbeat
```

A legacy Vercel GitHub check is not authoritative for VPS health.

## Reliability hardening already present

- durable lease + heartbeat;
- retry/recovery watchdog;
- provider submit permits/accounting fences;
- real Stop/cascade cancellation;
- AbortSignal propagation into provider/search/fetch paths;
- live Research Trace via durable progress events/SSE;
- bounded shared source pool and provider-call cap;
- coverage-aware research recovery;
- oversized Safe Fetch handling;
- schema deployment contract fence;
- explicit Human Gates;
- no new video spend without approved reference image.

## What is NOT yet product-accepted

Technical H3 integration is deployed, but the **real 10-second H3 gameplay quality acceptance** is still the next media checkpoint.

Need one controlled fresh chat run and human evaluation of:

- frame-0 preservation;
- actual player-bound camera;
- action correctness;
- world response/physics;
- teammate dependency;
- cinematic drift;
- identity/geometry drift;
- first-pass Human Video Gate verdict;
- actual cost / accepted shot.

Do not claim H3 has won the product-quality comparison until that real run is reviewed.

## Next product milestones

Near term:

1. real H3 10s acceptance;
2. fix only quality defects revealed by evidence;
3. Stage 5 Gameplay Quality Evaluator separating **game idea defect** from **artifact/provider defect**;
4. cost-per-accepted-shot instrumentation;
5. Stage 6 evidence-backed Learning/Memory Loop.

Longer-term ideas are in `docs/future-roadmap.md`, deliberately separated from current implementation.

## Non-negotiable invariants

1. DB state authoritative; queue is wake-up.
2. Human Concept/Image/Video Gates cannot be bypassed by default automation.
3. Human media decision cannot be silently replaced by AI aesthetic judgment.
4. Research without verifiable provenance is not evidence.
5. Paid retries/budgets are bounded and explicit.
6. Creative models cannot silently select provider routing.
7. Gameplay camera must remain actual player-visible camera.
8. Drive stores durable binaries; Supabase stores structured state/evidence/pointers.
9. Production app deploy is blocked by DB schema drift.
10. Historical failed/cancelled runs remain queryable evidence.

## Do not redo

- Do not rebuild Stage 4 from scratch.
- Do not restore 5-Scout/Council v2 as default merely because an old document calls it the target architecture.
- Do not switch H3 back to Kling because of stale metadata/comments.
- Do not bring back 9:16 source gameplay; source gameplay is 16:9.
- Do not use Vercel as production authority.
- Do not turn Human Gate feedback into opaque automatic fine-tuning.

For full details see `docs/implementation-current.md`; for future ideas see `docs/future-roadmap.md`.