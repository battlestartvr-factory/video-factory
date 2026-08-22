# Stage 4 — Economy, Human Approval and Feedback Policy

**Current policy — updated 2026-08-22.**

Этот документ описывает current downstream policy для gameplay evidence. Historical 5s/9:16/Kling-primary rules больше не действуют для default v3 chat path.

## 1. Economy is correctness

Factory не должна использовать более дорогую модель без product reason.

Routing principle:

1. deterministic code/schema/SQL first;
2. cheap reliable LLM for repair/classification/shot planning/feedback;
3. stronger creative model only where creative reasoning materially matters;
4. provider/media spend only after required gates;
5. no blind paid retry loops.

## 2. Current model routing

### V3 front-end

| Task | Current default |
|---|---|
| KIE grounded source acquisition | `gemini-3-6-flash`, minimal thinking |
| strong concept synthesis | `gpt-5-6-terra` through KIE |

### Stage 4 downstream (`lib/game-discovery/model-policy.ts`)

| Task | Default |
|---|---|
| gameplay moment planning | `gemini-3-pro` |
| schema repair | `gemini-3-6-flash` |
| concept pre-evaluation | `gemini-3-6-flash` — legacy task; v3 skips this edge after human approval |
| shot planning | `gemini-3-6-flash` |
| shot fallback | one bounded `gemini-3-pro` only when deterministic checks fail |
| feedback structuring | `gemini-3-6-flash` |
| gameplay reference captioning | `gemini-3-6-flash`, max one caption model call per attempt |
| prompt compilation | deterministic, no LLM |

`DISCOVERY_AUTOMATIC_TOP_TIER_ALLOWED=false` remains true for the Stage 4 task router. V3's explicit strong concept model is a separate current product policy and does not authorize arbitrary top-tier escalation inside downstream tasks.

## 3. Research budget policy

Current v3 shared source pool:

- max 10 accepted verified sources;
- min 4 verified sources;
- required competitor/mechanics/player_voice/gameplay_visual coverage;
- absolute max 6 KIE grounded-search/provider calls;
- ResearchPlan budget may lower that cap;
- Safe Fetch concurrency 3;
- targeted recovery only for missing coverage.

Do not restore five independent paid searches as default merely because the historical Stage 4.5 design used five Scouts.

## 4. Human Concept Gate

Human concept approval is a hard durable gate.

V3 behavior:

- exactly 3 conversational concepts presented;
- approve/revise/reject;
- human-approved concept proceeds directly to gameplay moment planning;
- legacy AI concept pre-evaluation cannot silently veto a v3 human approval.

## 5. Evidence-first media path

Current path:

```text
approved concept
 -> gameplay moment
 -> evidence-first ShotSpec
 -> deterministic PromptPlan
 -> GPT Image 2 gameplay still, 16:9
 -> HUMAN IMAGE APPROVAL
 -> GameplayVideoMotionPlan + pre-video gate
 -> MiniMax H3 gameplay video, default 10s / 768P
 -> HUMAN VIDEO APPROVAL
 -> assembly
```

No Human Image approve = no paid video.

## 6. Current source-format policy

Gameplay source is normal desktop PC footage:

- **16:9**;
- typical mental model: 1920x1080 gameplay monitor capture;
- not portrait/mobile/TikTok composition;
- player-visible gameplay camera;
- one evidence moment per current concept prototype.

Vertical/social crops, if ever needed, belong after gameplay evidence production; they must not distort source gameplay planning.

## 7. Current media providers

### Image

Default: `gpt-image-2`.

Purpose: an approval checkpoint that visibly proves the mechanic before video spend.

### Video

Primary: `minimax-h3` through KIE provider model `minimax/hailuo-03`.

Default:

- 10 seconds;
- 768P;
- image-to-video;
- approved gameplay still as start frame;
- audio off for discovery evidence.

H3 adapter accepts 4–15s; current shared factory duration buckets are 5/10/15 for fallback-compatible experiment semantics.

### Kling

`kling-3` remains enabled fallback/baseline. It is not the default generation plan.

## 8. Creative LLM cannot choose provider policy

Shot Planner may describe creative content but does not own provider routing.

Factory deterministically normalizes:

- image model;
- video model;
- video mode;
- aspect ratio;
- duration.

A stale LLM response requesting Kling cannot silently switch current H3 policy.

## 9. Gameplay authenticity is a spend gate

Before image/video provider calls typed deterministic checks require:

- obvious controllable player;
- physically attached/player-visible camera;
- visible player input;
- player action;
- immediate causal world response;
- meaningful gameplay affordance;
- visible co-op dependency;
- physically explainable state;
- readable risk/goal/action.

Cinematic/broadcast/spectator/drone/marketing-wide/detached camera is a hard defect before media spend.

When this gate rejects a shot, provider call must be blocked and cost-avoidance evidence retained.

## 10. Human Image Gate

Generated still review decisions:

- `approve` — unlock corresponding video branch;
- `revise` — save feedback and produce a new still revision, no video yet;
- `reject` — branch remains locked.

Partial review set stays parked until every active still has a decision.

Generated still is not auto-rejected by AI after generation.

## 11. Human Video Gate

Generated video review decisions:

- `approve` — eligible for assembly;
- `revise` — human-authorized new revision request;
- `reject` — not assembled.

Generated video is not auto-rejected by AI after generation.

A human-requested revision is not the same as blind technical retry: it is explicit new evidence spend and must preserve review/revision lineage.

## 12. Feedback memory

Human feedback must be durable.

Store/reuse only evidence-backed constraints:

- raw feedback;
- decision;
- error tags;
- `mustShow`;
- `mustAvoid`;
- scope;
- generation/revision lineage;
- structuring usage metadata.

Do not infer global aesthetic preferences from one local comment.

Useful recurring error tags include:

- `coop_dependency_not_visible`;
- `wrong_camera`;
- `too_cinematic`;
- `unreadable_consequence`;
- `players_act_independently`;
- `environment_obscures_mechanic`.

Tags must be supported by actual human feedback.

## 13. H3 prompt budget policy

Current compiler: `gameplay_prompt_compiler_v7_h3`.

H3 provider prompt profile has hard max 4800 chars.

Required behavior:

- compact semantically before provider submit;
- preserve frame-0 continuity and ordered gameplay motion;
- fail before paid submit if still oversized;
- **never** build a long prompt and blindly slice off the tail.

## 14. Cost metric

Do not optimize only `$ / generation`.

Primary future economics metric:

`total media/provider spend / human-accepted gameplay shot`

Example implication: a slightly more expensive model can be economically better if it materially reduces revisions/rejections.

Also track:

- first-pass image approval rate;
- first-pass video approval rate;
- revisions per accepted shot;
- cost avoided by pre-generation gates;
- technical retry spend vs human revision spend.

## 15. Retry policy

Technical provider/search failures may use bounded durable retry according to error classification and orchestrator policy.

Do not automatically retry:

- human rejection;
- weak concept;
- insufficient research evidence by simply doubling research budget;
- prompt schema bug with usable stored provider response;
- media defect without a deliberate revision/provider-fallback decision.

## 16. Provider fallback policy

Kling is currently available but not an invitation to automatic model hopping.

Until a separate fallback policy is implemented, provider switch should be explicit/controlled. A content rejection should never automatically cause another paid provider submit.

## 17. What this policy intentionally does not promise

- automatic quality evaluator after generated media;
- automatic fine-tuning from feedback;
- audio generation on every gameplay clip;
- multishot assembly;
- automatic premium resolution;
- automatic most-expensive-model escalation.

Those belong to future roadmap/Stage 5/6 decisions.

## 18. Current acceptance boundary

H3 code/provider/deploy integration is technically ready. Product-quality acceptance still requires one real 10-second chat run reviewed against camera, motion, physics, co-op readability and cost.

See `docs/future-roadmap.md` for next steps.