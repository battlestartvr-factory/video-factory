# Stage 4 — Game Discovery Pipeline v1

Status: design baseline for implementation on `stage4-game-discovery-pipeline`.

## 1. Product gate

Stage 4 is the first stage where the durable engine starts solving the actual product problem: **discovering and validating a real PC/Steam friends co-op game idea**.

Every Stage 4 feature must directly improve at least one of:
- number/reliability of independent game-concept experiments;
- concept diversity/novelty;
- ability to understand why a concept works or fails;
- cost/time per tested game hypothesis;
- lineage from discovery objective to concept/moment/generated evidence;
- ability to turn a strong fake-gameplay idea into a prototype candidate later.

Non-goals for Stage 4:
- full Stage 5 evaluator;
- audience ingestion/posting;
- broad trend radar;
- automatic durable learning writes;
- custom model training;
- infrastructure changes that are not required by the discovery loop.

## 2. Stage 4 Definition of Done

From one `DiscoveryObjectiveSpec`, the system can automatically:
1. generate several substantially different `CoopGameConceptSpec` candidates;
2. reject near-duplicates and replace them using explicit novelty axes;
3. pre-filter concepts that lack real co-op dependency/readability or have obviously impractical scope;
4. select a concrete `GameplayMomentSpec` for each surviving concept;
5. build a typed shot/prompt/asset plan;
6. generate the required image/video assets through the existing durable media workflows;
7. assemble a deterministic 9:16 short with FFmpeg;
8. store complete lineage back to the original objective/hypothesis.

Stage 4 is complete when the above path is restart-safe through the Stage 3 orchestrator and can be inspected from the product UI.

## 3. Core domain contracts

The domain layer is versioned TypeScript/Zod data stored in existing `creative_runs.inputs`, `creative_runs.outputs`, and `creative_runs.metadata`. We do **not** create a column for every game-domain field in v1.

Every domain payload has:

```ts
{
  schema: "...",
  version: 1,
  ...payload
}
```

### 3.1 DiscoveryObjectiveSpec v1

```ts
interface DiscoveryObjectiveSpecV1 {
  schema: "discovery_objective";
  version: 1;
  objectiveId: string;
  title: string;
  searchIntent: string;
  playerCount: { min: 2; max: 4 };
  platform: "pc_steam";
  desiredNovelty: "explore" | "balanced" | "exploit";
  conceptCount: number;              // default 6, hard cap v1 = 12
  maxConceptsToPrototype: number;     // default 2
  constraints: {
    maxMvpMonths?: number;
    networkingComplexity?: "low" | "medium";
    contentBurden?: "low" | "medium";
    npcAiDependency?: "avoid" | "allow_light";
    forbiddenPatterns?: string[];
  };
  searchSpace?: {
    dependencyTypes?: string[];
    socialTensions?: string[];
    tempos?: string[];
    cameras?: string[];
    failureSignatures?: string[];
  };
}
```

### 3.2 CoopGameConceptSpec v1

Required fields are taken directly from the Product Constitution.

```ts
interface CoopGameConceptSpecV1 {
  schema: "coop_game_concept";
  version: 1;
  conceptId: string;
  oneSentencePitch: string;
  coreMechanic: string;
  coopDependency: string;
  playerRoles: Array<{
    role: string;
    responsibility: string;
    information?: string;
    power?: string;
  }>;
  playerCount: { min: number; max: number; ideal: number };
  interactionModel: string[];
  failureMode: string;
  socialMoment: string;
  gameplayHook: string;
  spectacle: string;
  setting: string;
  artDirection: string;
  camera: string;
  readability: string;
  noveltyAxes: Array<{
    axis: string;
    choice: string;
    whyDifferent: string;
  }>;
  buildability: {
    networking: "low" | "medium" | "high";
    physics: "low" | "medium" | "high";
    contentBurden: "low" | "medium" | "high";
    npcAiDependency: "none" | "light" | "heavy";
    systemicInteractions: "low" | "medium" | "high";
    mainRisks: string[];
    mvpRead: string;
  };
  referenceInfluences: Array<{
    reference: string;
    borrowedPrinciple: string;
    mustNotCopy: string;
  }>;
}
```

### 3.3 GameplayMomentSpec v1

A concept and a video are different entities. The moment must prove the mechanic, not merely the setting.

```ts
interface GameplayMomentSpecV1 {
  schema: "gameplay_moment";
  version: 1;
  momentId: string;
  conceptId: string;
  hypothesis: string;
  durationTargetSec: number;
  setup: string;
  playerActions: Array<{
    role: string;
    action: string;
    dependencyOnOthers: string;
  }>;
  coopDependencyEvidence: string;
  socialTension: string;
  successBeat?: string;
  failureBeat?: string;
  expectedViewerUnderstanding: string;
  cameraIntent: string;
  requiredVisualEvidence: string[];
}
```

### 3.4 ShotSpec v1

```ts
interface ShotSpecV1 {
  schema: "gameplay_shot";
  version: 1;
  shotId: string;
  momentId: string;
  order: number;
  durationSec: number;
  purpose: "hook" | "mechanic" | "escalation" | "failure" | "payoff";
  actors: string[];
  action: string;
  camera: string;
  environment: string;
  continuity: {
    previousShotId?: string;
    preserve: string[];
  };
  expectedEvidence: string[];
  generationPlan: {
    keyframeRequired: boolean;
    imageModel?: "gpt-image-2" | "nano-banana-2" | "nano-banana-pro";
    videoModel: string;
    videoMode: "text-to-video" | "image-to-video";
    aspectRatio: "9:16";
    durationSec: number;
  };
}
```

### 3.5 PromptPlan v1

Prompt text is a compiled artifact, not the source of product semantics.

```ts
interface PromptPlanV1 {
  schema: "prompt_plan";
  version: 1;
  conceptId: string;
  momentId: string;
  shotId: string;
  imagePrompt?: string;
  videoPrompt: string;
  negativeConstraints: string[];
  compilerInputsHash: string;
  providerModel: string;
}
```

### 3.6 AssetGraph v1

```ts
interface AssetGraphV1 {
  schema: "asset_graph";
  version: 1;
  objectiveRunId: string;
  conceptRunId: string;
  nodes: Array<{
    id: string;
    kind: "concept" | "moment" | "shot" | "image" | "video" | "short";
    creativeRunId?: string;
    generationId?: string;
    driveFileId?: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    relation: "plans" | "keyframe_for" | "animates" | "assembles_into" | "evidence_for";
  }>;
}
```

## 4. Mapping onto the existing Creative Data Model

No replacement of Stage 2 tables.

### Root discovery run
- `creative_runs.run_type = mixed`
- `objective` = human discovery objective
- `hypothesis` = search hypothesis
- `inputs.discovery_objective` = `DiscoveryObjectiveSpecV1`
- `outputs.discovery_summary` = batch summary
- `metadata.domain_kind = game_discovery_batch`

### Concept runs
One child `creative_run` per accepted concept:
- `run_type = concept`
- `parent_run_id = root discovery run`
- `outputs.coop_game_concept` = `CoopGameConceptSpecV1`
- `metadata.domain_kind = coop_game_concept`

Rejected/generated duplicates are kept as evidence in the root run output/rejection log; they do not need permanent first-class concept runs in v1.

### Moment/shot/media runs
Generated media keeps the existing image/video creative lineage. Stage 4 adds the domain IDs (`conceptId`, `momentId`, `shotId`) in inputs/metadata and references the concept run through `parent_run_id`/`creative_references`.

This keeps lineage queryable without introducing a parallel game database.

## 5. Durable workflow design

New workflow:

`game_discovery_batch@1`

Proposed state progression:

```text
queued
  -> objective_ready
  -> generating_concepts
  -> diversity_filtering
  -> pre_evaluating
  -> planning_moments
  -> planning_shots
  -> compiling_prompts
  -> generating_assets
  -> assembling_shorts
  -> finalizing_lineage
  -> completed
```

The parent Stage 4 job owns planning state; paid media work is delegated to existing durable `generation_image@1` and `generation_video@1` child jobs.

### 5.1 Minimal child-job dependency support

Stage 4 needs one small extension to Stage 3 rather than a new orchestrator:
- add nullable `parent_job_id` to `factory_jobs`;
- child job input includes `parent_job_id`, `concept_id`, `moment_id`, `shot_id`;
- parent job can enter a waiting state with an explicit list of child job IDs;
- watchdog requeues the parent when children are terminal;
- child completion does not directly mutate the parent state; it only wakes/requeues it.

This preserves the Stage 3 rule: queue delivery is a wake-up signal, DB state is authoritative.

## 6. Concept Generator / Explorer v1

Default model: **Claude Sonnet 5** for structured concept reasoning. Haiku 4.5 may be used for cheap repair/reformat passes.

V1 uses a small number of structured LLM calls rather than one call per concept:
1. retrieve project constraints + recent concept history;
2. ask for `conceptCount + replacementBuffer` typed candidates;
3. parse with strict schema;
4. if parsing fails, one structured repair pass;
5. persist raw provider response hash + parsed typed result.

Default first batch:
- requested concepts: 6;
- prototype budget: top 2 concepts after diversity/pre-eval;
- one gameplay moment per selected concept;
- one keyframe + one 5s video shot per selected concept in the first production smoke.

This keeps the first Stage 4 end-to-end smoke financially controlled while proving the complete loop.

## 7. Diversity Guard v1

Stage 4 diversity must be deterministic enough to explain rejections.

### Axes
Use the Constitution axes:
- dependency type;
- social tension;
- tempo;
- scale/camera;
- failure signature;
- buildability shape.

### V1 distance rule
For each candidate, derive a normalized signature. Compare against:
1. already accepted concepts in the current batch;
2. a bounded project history window (default latest 200 concept runs).

Hard duplicate if any of these is true:
- same normalized `coreMechanic` + same dependency type;
- same dependency/social-tension/failure-signature triple;
- fewer than 2 meaningfully different novelty axes from the nearest batch concept.

Soft-near-duplicate if axis distance is low; ask the generator for a replacement using the exact rejection reason and the underexplored axes.

Do not add embeddings infrastructure in Stage 4 solely for this. Embedding/clustering belongs later when the existing deterministic axes stop being sufficient.

## 8. Concept Pre-Evaluator v1

This is **not Stage 5** and must not become a giant scoring system.

It is a cheap gate with three explicit decisions:

```ts
interface ConceptPreEvaluationV1 {
  coOpDependency: "pass" | "fail";
  instantReadability: "pass" | "fail";
  buildability: "pass" | "fail";
  rejectionReasons: string[];
  cautionFlags: string[];
}
```

Fail if:
- a second player is optional rather than mechanically necessary;
- the interesting part cannot be made visible in a few seconds;
- the MVP requires clearly excessive AI/content/networking scope for the current team assumptions.

Novelty is handled primarily by Diversity Guard, not hidden inside one overall score.

## 9. Gameplay Moment Planner v1

For each surviving concept, choose one moment that exposes:
- the exact co-op dependency;
- a social reaction (coordination/blame/rescue/panic/etc.);
- a visually legible success or failure consequence;
- a camera that makes the mechanic understandable without explanation.

The planner must explicitly answer: **what will the viewer see that proves this is a game worth exploring?**

## 10. Prompt Compiler v1

Provider prompts are generated from typed domain inputs.

Compiler responsibilities:
- preserve the core mechanic and role dependencies;
- make visual evidence explicit;
- enforce fake-gameplay readability (camera, character positions, interactable object, visible consequence);
- add provider-specific constraints;
- never mutate the game concept merely to make a prettier image/video.

The prompt compiler output is versioned and hashed so later evaluation can distinguish concept failure from prompt/compiler failure.

## 11. Media path v1

Default controlled path:

```text
Concept
 -> Gameplay Moment
 -> ShotSpec
 -> image keyframe (durable image workflow)
 -> 5s image-to-video (durable video workflow)
 -> Drive archive
 -> FFmpeg deterministic 9:16 short
 -> Drive archive
```

Model selection remains config-driven. Initial recommended baseline:
- keyframe: GPT Image 2 or Nano Banana 2;
- video: Kling 3 image-to-video;
- one output per task during discovery.

Stage 4 does not add models merely to increase catalogue size.

## 12. FFmpeg Assembly v1

Worker scratch path:

`/srv/ai-factory/scratch/<parent-job-id>/`

Deterministic export baseline:
- MP4 / H.264;
- 1080x1920;
- 30 fps;
- source aspect preserved via scale/pad/crop policy recorded in metadata;
- deterministic naming from objective/concept/moment/assembly version;
- `ffprobe` result persisted: duration, dimensions, fps, streams;
- exact assembly version + command template + input hashes persisted.

Final short is archived to Google Drive under a generated-shorts hierarchy. Supabase stores only metadata/IDs/pointers.

Scratch is removed after successful archive; failures keep only a bounded diagnostic bundle.

## 13. Product UI v1

Add a first-class **Discovery** surface rather than hiding Stage 4 only behind technical APIs.

Minimal UI:
- new left-nav item `Discovery` / `Поиск игры`;
- objective composer with batch size and exploration mode;
- current batch progress/stage;
- concept cards showing pitch, co-op dependency, novelty axes, pre-eval outcome;
- generated gameplay moment and short per prototyped concept;
- links to full lineage/results.

Human Love/Maybe/Reject is Stage 5 data and can be added immediately after Stage 4 without changing this pipeline.

Chat integration:
- Universal Agent may launch the same canonical discovery service via a `run_game_discovery` tool;
- Chat does not own the workflow state.

## 14. Cost controls

Stage 4 is an experiment engine, so cost is part of correctness.

Before paid media generation:
- concept batch and pre-eval must finish first;
- only `maxConceptsToPrototype` concepts advance;
- default 1 image + 1 video task per selected concept;
- cost estimates aggregate from child generation jobs into the root creative run/job;
- no automatic regeneration loop in Stage 4; selective regeneration belongs to Stage 5.

A batch must expose:
- concept count generated/accepted/rejected;
- paid media task count;
- estimated and actual cost;
- time from objective to first playable-looking evidence.

## 15. Failure/recovery semantics

- LLM parse failures: repair once, then fail the stage with raw-response evidence retained.
- Diversity replacement loop: bounded attempts; never infinite regeneration.
- Child media job failure: parent records the failed shot and either fails the concept branch or completes the batch partially according to explicit policy.
- Parent worker restart: current stage and child IDs are recoverable from DB.
- Duplicate wakeups/callbacks: no duplicate child generation admission.
- FFmpeg failure: retry assembly without re-running provider generations.
- Drive archive failure: retry archive/assembly completion without re-running provider generation.

## 16. Implementation slices

### S4-001 — Typed Game Domain
- Zod schemas for Objective, Concept, Moment, Shot, PromptPlan, AssetGraph, PreEvaluation.
- schema/version helpers and fixtures.
- unit tests for strict parsing and forward-compatible metadata envelopes.

### S4-002 — Discovery persistence + admission
- canonical `createGameDiscoveryBatch()` service;
- root `creative_run` + durable `factory_job` admission atomically;
- `game_discovery_batch@1` registered in worker;
- minimal `parent_job_id`/child dependency primitives if required.

### S4-003 — Concept Explorer + Diversity Guard
- Sonnet 5 structured batch generation;
- bounded history retrieval;
- deterministic axis signatures/distance;
- replacement loop for duplicates;
- persist accepted concepts as child creative runs.

### S4-004 — Pre-Eval + Moment/Shot planning
- three-gate pre-evaluator;
- GameplayMomentSpec planner;
- ShotSpec planner;
- prompt compiler with version/hash.

### S4-005 — Asset Graph + durable media fan-out
- create keyframe/image child generation;
- create video child generation after keyframe completion;
- wait/wakeup/recovery;
- full concept/moment/shot/generation lineage.

### S4-006 — FFmpeg short assembly + Drive archive
- deterministic local assembly;
- ffprobe descriptors;
- Drive archive for final shorts;
- scratch lifecycle/cleanup.

### S4-007 — Discovery UI + Chat launch
- `/discovery` internal product page;
- batch progress and concept cards;
- playable outputs;
- Universal Agent `run_game_discovery` tool.

### S4-008 — Production gate
- one cheap dry/synthetic pipeline through planning;
- one controlled real batch with 3–6 concepts but media generated only for top 1–2;
- verify restart/recovery without duplicate paid media;
- verify complete lineage/objective → concept → moment → asset → short;
- merge Stage 4 only after the full loop is inspectable.

## 17. Explicitly deferred debt

These do not block Stage 4 unless they prevent the discovery loop:
- current Google Drive knowledge-file delete ownership limitation (now fail-safe rather than orphaning silently);
- historical Knowledge Drive orphans from older deletion behavior;
- Vercel preview-rate-limit noise (production is VPS-first);
- full human/multi-axis evaluator (Stage 5);
- automatic evidence-backed memory writeback (Stage 6);
- market/reference sensing (Stage 7);
- audience metrics (Stage 8).

## 18. First implementation decision

Start with **S4-001 Typed Game Domain**, then immediately S4-002 admission/workflow skeleton. Do not start by building a large UI or adding provider models.

The first meaningful Stage 4 proof is not a pretty screen. It is a durable batch that produces several structurally different typed co-op concepts, rejects duplicates for explainable reasons, and can advance the strongest concept into a concrete gameplay moment with complete lineage.
