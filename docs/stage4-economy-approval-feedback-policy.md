# Stage 4 — Token Economy, Reference Approval and Feedback Memory Policy

Status: **approved product decision — 2026-08-18**.

This document is a durable Stage 4 rule, not an optional optimization. It records the approved operating policy for the AI Co-op Game Discovery Factory so the decisions are not lost between implementation sessions.

## 1. Token economy is correctness

The factory must not use a frontier model merely because it is available. Every task should run on the cheapest reliable execution class that preserves the product decision being made.

Routing order:
1. deterministic code / schema / SQL when an LLM is unnecessary;
2. cheap fast LLM (`Claude Haiku 4.5`, with `Gemini 3.6 Flash` as a future compatible cheap fallback) for classification, extraction, repair, critique and feedback structuring;
3. creative reasoning LLM (`Claude Sonnet 5`) only for core creative synthesis such as concept exploration and gameplay-moment selection;
4. top-tier frontier models such as `GPT 5.6 Sol` are **not automatically allowed** inside the Stage 4 discovery loop. A later explicit human override may authorize one and must be recorded separately.

The canonical task policy lives in `lib/game-discovery/model-policy.ts`.

### Current task routing

| Task | Default execution |
|---|---|
| deterministic diversity/buildability checks | no LLM |
| concept generation | Sonnet 5 |
| schema/JSON repair | Haiku 4.5 |
| concept pre-evaluation | Haiku 4.5 |
| gameplay moment planning | Sonnet 5 |
| first shot planning | Haiku 4.5; one bounded Sonnet escalation only if deterministic evidence checks fail |
| prompt compilation | no LLM |
| human feedback structuring | Haiku 4.5 |

Every LLM task has bounded output tokens and bounded call/retry counts. No unbounded regeneration or automatic frontier-model escalation is permitted.

## 2. Human reference-image approval is a hard gate

The factory must never go directly from a planned gameplay moment to paid video generation.

Required path:

```text
concept
 -> gameplay moment
 -> evidence-first ShotSpec
 -> deterministic PromptPlan
 -> reference gameplay still
 -> HUMAN APPROVAL / FEEDBACK
 -> only then video generation
```

A reference still is a product checkpoint, not decoration. It must show the gameplay interaction clearly enough for the human reviewer to answer whether the intended mechanic is actually visible.

Allowed review decisions:
- `approve` — the still may unlock the corresponding video branch;
- `revise` — use feedback to regenerate/replan the reference, without video generation;
- `reject` — the branch remains locked and the rejection becomes evidence.

**No approved reference image = no automatic video generation.**

## 3. Feedback must become durable constraints

Human review feedback is not treated as disposable chat context and does not imply model fine-tuning in Stage 4.

The factory stores:
- raw human feedback;
- explicit approval decision;
- structured error tags;
- `mustShow` constraints;
- `mustAvoid` constraints;
- reusable scope (`shot`, `concept`, or `project`);
- model/usage metadata for the cheap structuring pass.

The persistent table is `gameplay_reference_reviews`.

The factory retrieves relevant prior review memory before replanning/regenerating a gameplay reference. Project-wide rules are reused only when the original feedback was clearly general enough to deserve `project` scope. One-off aesthetic comments must not silently become global preferences.

## 4. Obvious rejected mistakes must not be repeated

Examples of reusable error tags include:
- `coop_dependency_not_visible`;
- `wrong_camera`;
- `too_cinematic`;
- `unreadable_consequence`;
- `players_act_independently`;
- `environment_obscures_mechanic`.

Tags are only stored when supported by the human feedback. The cheap feedback structurer must not invent preferences or criticism.

Future ShotSpec and PromptPlan generation receives the relevant `mustShow`, `mustAvoid`, and error tags. Prompt compilation adds these as explicit visual constraints. This is the Stage 4 learning mechanism: **persistent evidence-backed prompt/planning memory, not opaque autonomous fine-tuning**.

## 5. Evidence-first shot rule

The first production smoke uses one narrow 5-second evidence shot per selected concept:
- `9:16`;
- reference keyframe required;
- reference image baseline: `nano-banana-2`;
- video baseline: `kling-3`, image-to-video;
- all mechanically necessary roles visible;
- every `GameplayMomentSpec.requiredVisualEvidence` item must be copied into `ShotSpec.expectedEvidence` so coverage can be checked deterministically.

The cheap Shot Planner is allowed one bounded Sonnet escalation only when deterministic evidence checks show that the cheap draft did not cover the required mechanic.

## 6. Safety invariant for Stage 4 implementation

Paid media is not considered ready merely because prompts exist. Before the first real Stage 4 media smoke, the product must have an inspectable approval surface that can show reference images, accept `approve/revise/reject`, save feedback, and keep video branches locked until approval.

Until that surface exists, the durable workflow must park before paid reference generation or at the explicit human approval gate. It must never silently progress to video.
