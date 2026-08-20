import { createHash } from "node:crypto";
import {
  buildGameplayVideoMotionPlan,
  gameplayAuthenticitySpecFromShot,
} from "./gameplay-authenticity";
import {
  gameplayReferenceLetter,
  type Stage4GameplayReferenceSet,
} from "./gameplay-reference-stage4";
import type { DiscoveryFeedbackMemory } from "./shot-planner";
import {
  promptPlanV1Schema,
  type CoopGameConceptSpecV1,
  type GameplayMomentSpecV1,
  type PromptPlanV1,
  type ShotSpecV1,
} from "./schemas";

export const GAMEPLAY_PROMPT_COMPILER_VERSION = "gameplay_prompt_compiler_v5";
const GAMEPLAY_PROMPT_SCHEMA_MAX_CHARS = 8_000;
const GAMEPLAY_PROMPT_TARGET_MAX_CHARS = 7_200;

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function clean(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function clipText(value: string, max: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function clippedList(items: string[], input?: { maxItems?: number; maxChars?: number }): string[] {
  const maxItems = input?.maxItems ?? items.length;
  const maxChars = input?.maxChars ?? 240;
  return clean(items).slice(0, maxItems).map((item) => clipText(item, maxChars));
}

function evidenceBlock(shot: ShotSpecV1): string {
  return clippedList(shot.expectedEvidence, { maxItems: 5, maxChars: 140 })
    .map((item, index) => `${index + 1}. ${item}`)
    .join("\n");
}

function compactPurposeInstruction(purpose: Stage4GameplayReferenceSet["references"][number]["purpose"]): string {
  switch (purpose) {
    case "gameplay_camera":
      return "Use only for player-camera grammar: attachment, embodiment, foreground body/tool and teammate distance.";
    case "interaction":
      return "Use only for interaction framing: target distance, affordance placement and visible input-to-response.";
    case "coop":
      return "Use only for co-op readability: teammate dependency, shared work and coordination inside a playable frame.";
    case "art_direction":
      return "Use only for stylization, materials, lighting and indie/AA scope; never inherit its camera grammar.";
  }
}

function compactGameplayReferenceInstructionBlock(
  input: Stage4GameplayReferenceSet | null | undefined,
): string {
  if (!input?.references.length) return "No external gameplay reference images were selected.";

  const refs = input.references.map((item, index) => {
    const reason = clippedList(item.whySelected, { maxItems: 1, maxChars: 65 })[0];
    return [
      `Reference ${gameplayReferenceLetter(index)} — ${item.purpose.toUpperCase()} — ${clipText(item.gameName, 50)}.`,
      compactPurposeInstruction(item.purpose),
      `Gameplay evidence: ${clipText(item.gameplayDescription, 110)}`,
      `Why gameplay: ${clipText(item.whyThisLooksLikeGameplay, 80)}${reason ? ` Selection: ${reason}.` : ""}`,
    ].join("\n");
  });

  return `${refs.join("\n\n")}\n\nREFERENCE FIREWALL: use each image only for its labeled purpose. Do not copy game identity, characters, level, props, logos, branded UI or original mechanic. Art direction never overrides player-camera grammar.`;
}

function assertPromptBudget(label: string, value: string): string {
  if (value.length > GAMEPLAY_PROMPT_SCHEMA_MAX_CHARS) {
    throw new Error(`${label}_BUDGET_EXCEEDED:${value.length}:${GAMEPLAY_PROMPT_SCHEMA_MAX_CHARS}`);
  }
  return value;
}

export function compileGameplayPromptPlan(input: {
  concept: CoopGameConceptSpecV1;
  moment: GameplayMomentSpecV1;
  shot: ShotSpecV1;
  feedbackMemory?: DiscoveryFeedbackMemory;
  gameplayReferences?: Stage4GameplayReferenceSet;
}): PromptPlanV1 {
  const feedback = input.feedbackMemory ?? { mustShow: [], mustAvoid: [], errorTags: [] };
  const { concept, moment, shot } = input;
  const gameplayReferences = input.gameplayReferences;

  if (shot.momentId !== moment.momentId) {
    throw new Error(`PROMPT_COMPILER_MOMENT_MISMATCH:${shot.shotId}:${moment.momentId}`);
  }
  if (moment.conceptId !== concept.conceptId) {
    throw new Error(`PROMPT_COMPILER_CONCEPT_MISMATCH:${moment.momentId}:${concept.conceptId}`);
  }

  const authenticity = gameplayAuthenticitySpecFromShot(shot);
  if (!authenticity.passed) {
    throw new Error(
      `PROMPT_COMPILER_GAMEPLAY_AUTHENTICITY_FAILED:${shot.shotId}:${authenticity.hardFailures.join(",")}`,
    );
  }
  const motionPlan = buildGameplayVideoMotionPlan(shot, authenticity);
  if (!motionPlan.passed) {
    throw new Error(
      `PROMPT_COMPILER_VIDEO_AUTHENTICITY_FAILED:${shot.shotId}:${motionPlan.gateFailures.join(",")}`,
    );
  }

  // Human constraints and shot-specific proof outrank broad moment wording when context must be bounded.
  const humanMustShow = clippedList(feedback.mustShow, { maxItems: 5, maxChars: 180 });
  const humanMustAvoid = clippedList(feedback.mustAvoid, { maxItems: 5, maxChars: 180 });
  const humanErrorTags = clippedList(feedback.errorTags, { maxItems: 5, maxChars: 100 });
  const imageHumanMustShow = clippedList(feedback.mustShow, { maxItems: 3, maxChars: 100 });
  const imageHumanMustAvoid = clippedList(feedback.mustAvoid, { maxItems: 3, maxChars: 100 });
  const imageHumanErrorTags = clippedList(feedback.errorTags, { maxItems: 3, maxChars: 70 });
  const mustShow = clippedList(
    [...feedback.mustShow, ...shot.expectedEvidence, ...moment.requiredVisualEvidence],
    { maxItems: 5, maxChars: 120 },
  );
  const negativeConstraints = clean([
    "do not turn the scene into cinematic concept art",
    "do not hide either mechanically necessary player",
    "do not change the core mechanic or player dependency",
    "do not use a camera angle that makes the interaction unreadable",
    "do not add decorative effects that obscure the gameplay consequence",
    "do not copy the identity, characters, level, branded UI, props or mechanic of any gameplay reference",
    "do not let an art-direction reference override gameplay camera grammar",
    "do not add decorative HUD that is unrelated to player decisions or the visible action",
    "do not detach the camera from the controllable player",
    ...feedback.mustAvoid,
    ...feedback.errorTags.map((tag) => `do not repeat rejected error pattern: ${tag}`),
  ]);
  const humanFeedbackBlock = [
    humanMustShow.length
      ? `Preserve / make visible:\n${humanMustShow.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
      : "Preserve / make visible: no additional human requirement.",
    humanMustAvoid.length
      ? `Do not repeat:\n${humanMustAvoid.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
      : "Do not repeat: no additional human rejection pattern.",
    humanErrorTags.length
      ? `Rejected error tags:\n${humanErrorTags.map((item) => `- ${item}`).join("\n")}`
      : "Rejected error tags: none.",
  ].join("\n\n");
  const imageHumanFeedbackBlock = [
    imageHumanMustShow.length ? `Keep: ${imageHumanMustShow.join(" | ")}` : null,
    imageHumanMustAvoid.length ? `Avoid: ${imageHumanMustAvoid.join(" | ")}` : null,
    imageHumanErrorTags.length ? `Rejected tags: ${imageHumanErrorTags.join(", ")}` : null,
  ].filter((item): item is string => Boolean(item)).join("\n") || "No additional human feedback.";
  const referenceBlock = compactGameplayReferenceInstructionBlock(gameplayReferences);
  const affordanceBlock = clipText(
    authenticity.gameplayAffordances
      .filter((item) => item.visible && item.meaningful)
      .slice(0, 3)
      .map((item) => `${item.type}: ${clipText(item.informationUsedByPlayer, 90)}`)
      .join("; ") || "No meaningful affordance specified.",
    300,
  );
  const physicsExceptions = authenticity.physics.exceptions.length
    ? clipText(
        authenticity.physics.exceptions
          .slice(0, 3)
          .map(
            (item) =>
              `${clipText(item.entity, 55)}: ${clipText(item.reason, 90)}; visible: ${clipText(item.visualEvidence, 90)}`,
          )
          .join(" | "),
        300,
      )
    : "No unexplained physics exceptions.";

  const imagePrompt = assertPromptBudget(
    "PROMPT_COMPILER_IMAGE",
    `FAKE GAMEPLAY REFERENCE STILL — approval checkpoint before any video generation.\n\nPLAYABLE BEAT:\nConcept: ${clipText(concept.oneSentencePitch, 220)}\nMechanic: ${clipText(concept.coreMechanic, 240)}\nScene: ${clipText(moment.setup, 280)}\n\nPLAYER INPUT -> ACTION -> WORLD RESPONSE:\nControllable player: ${clipText(authenticity.controllablePlayer.role, 80)}; this player must be visually obvious.\nInput: ${clipText(authenticity.playerInput.input, 150)}\nVisible input evidence: ${clipText(authenticity.playerInput.visibleEvidence, 170)}\nAction: ${clipText(authenticity.playerAction.action, 180)}\nTarget: ${clipText(authenticity.playerAction.target, 140)}\nWorld response: ${clipText(authenticity.worldResponse.response, 220)}\n\nPLAYER-BOUND CAMERA:\nCamera type: ${authenticity.camera.type}; physically attached to the controllable player's gameplay viewpoint. ${clipText(authenticity.camera.visibleEvidence, 180)}\nShot framing: ${clipText(shot.camera, 220)}\n\nMEANINGFUL GAMEPLAY AFFORDANCES:\n${affordanceBlock}\n\nCO-OP DEPENDENCY:\n${clipText(authenticity.coop.teammateFunction, 180)}\nVisible evidence: ${clipText(authenticity.coop.visualEvidence, 180)}\n\nPHYSICS CONTRACT:\n${clipText(authenticity.physics.event, 180)}\nAffected: ${clipText(authenticity.physics.affectedEntities.join(", "), 160)}\n${physicsExceptions}\n\nART / READABILITY:\n${clipText(concept.artDirection, 180)}\nStylized indie / AA by default, not photoreal expensive AAA cinematic polish.\n${clipText(concept.readability, 160)}\n\nPURPOSE-LABELED REAL GAMEPLAY REFERENCES:\nAttached images are ordered as Reference A, B, and so on. Each has one narrow role.\n\n${referenceBlock}\n\nHUMAN FEEDBACK MEMORY — HUMAN DECISIONS OVERRIDE AESTHETIC GUESSING:\n${imageHumanFeedbackBlock}\n\nTHE STILL MUST VISIBLY PROVE:\n${mustShow.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\nThis exact image must plausibly be an in-engine PC co-op gameplay screenshot captured while a person is actively playing, not key art, a trailer frame, a spectator view, a staged animation or a promotional composition.`,
  );

  const beatBlock = motionPlan.beats
    .map(
      (beat) =>
        `${beat.startSec.toFixed(1)}–${beat.endSec.toFixed(1)} sec — ${clipText(beat.description, 300)}`,
    )
    .join("\n");
  const videoPrompt = assertPromptBudget(
    "PROMPT_COMPILER_VIDEO",
    `Animate the approved gameplay reference still into one continuous 5-second capture of one active gameplay session. Preserve character identities, positions, environment, art direction, interactable objects, meaningful HUD/affordances, and the approved player-camera composition.\n\nHARD CAMERA CONTRACT:\ncamera remains physically attached to the playable character for the entire clip\nNo cinematic reframing, camera orbit, dolly shot, cutaway, dramatic zoom, detached camera, spectator movement, or automatic hero framing.\n\nPLAYABLE 5-SECOND BEAT:\n${beatBlock}\n\nCONTROLLABLE PLAYER INPUT:\n${clipText(authenticity.playerInput.input, 220)}\n\nACTION:\n${clipText(authenticity.playerAction.action, 300)}\n\nWORLD RESPONSE CAUSED BY THAT ACTION:\n${clipText(authenticity.worldResponse.response, 360)}\n\nTEAMMATE DEPENDENCY:\n${clipText(authenticity.coop.teammateFunction, 260)}\n${clipText(authenticity.coop.visualEvidence, 280)}\n\nGAMEPLAY MOMENT HYPOTHESIS:\n${clipText(moment.hypothesis, 280)}\n\nHUMAN FEEDBACK MEMORY — APPLY THIS TO THE REGENERATION:\n${humanFeedbackBlock}\n\nVISIBLE EVIDENCE THAT MUST REMAIN LEGIBLE:\n${evidenceBlock(shot)}\n\nCAMERA:\n${clipText(shot.camera, 320)}\n\nThe result must plausibly be five seconds a player could obtain by pressing Record while actually playing. Do not introduce a new mechanic, location, camera cut, trailer montage, unrelated spectacle, or animation unrelated to player input/gameplay state. Human feedback above is authoritative for what to preserve or correct; never replace an approved creative choice merely because another aesthetic option seems cleaner.`,
  );

  const compilerInputsHash = stableHash({
    compiler: GAMEPLAY_PROMPT_COMPILER_VERSION,
    concept,
    moment,
    shot,
    feedback,
    gameplayReferences: gameplayReferences ?? null,
    authenticity,
    motionPlan,
  });

  return promptPlanV1Schema.parse({
    schema: "prompt_plan",
    version: 1,
    conceptId: concept.conceptId,
    momentId: moment.momentId,
    shotId: shot.shotId,
    imagePrompt,
    videoPrompt,
    negativeConstraints,
    compilerInputsHash,
    providerModel: shot.generationPlan.videoModel,
    metadata: {
      compiler_version: GAMEPLAY_PROMPT_COMPILER_VERSION,
      image_model: shot.generationPlan.imageModel ?? null,
      reference_approval_required: true,
      human_feedback_applied:
        feedback.mustShow.length + feedback.mustAvoid.length + feedback.errorTags.length > 0,
      gameplay_reference_set: gameplayReferences ?? null,
      gameplay_reference_count: gameplayReferences?.references.length ?? 0,
      gameplay_reference_roles: gameplayReferences?.references.map((item) => item.purpose) ?? [],
      gameplay_authenticity: authenticity,
      gameplay_video_motion_plan: motionPlan,
      gameplay_authenticity_gate_passed: true,
      video_authenticity_gate_passed: true,
      prompt_budget: {
        schema_max_chars: GAMEPLAY_PROMPT_SCHEMA_MAX_CHARS,
        target_max_chars: GAMEPLAY_PROMPT_TARGET_MAX_CHARS,
        image_prompt_chars: imagePrompt.length,
        video_prompt_chars: videoPrompt.length,
      },
    },
  });
}

export function compileGameplayPromptPlans(input: {
  concepts: CoopGameConceptSpecV1[];
  moments: GameplayMomentSpecV1[];
  shots: ShotSpecV1[];
  feedbackMemory?: DiscoveryFeedbackMemory;
  gameplayReferencesByShot?: Record<string, Stage4GameplayReferenceSet>;
}): PromptPlanV1[] {
  const conceptById = new Map(input.concepts.map((concept) => [concept.conceptId, concept]));
  const momentById = new Map(input.moments.map((moment) => [moment.momentId, moment]));

  return input.shots.map((shot) => {
    const moment = momentById.get(shot.momentId);
    if (!moment) throw new Error(`PROMPT_COMPILER_MOMENT_NOT_FOUND:${shot.momentId}`);
    const concept = conceptById.get(moment.conceptId);
    if (!concept) throw new Error(`PROMPT_COMPILER_CONCEPT_NOT_FOUND:${moment.conceptId}`);
    return compileGameplayPromptPlan({
      concept,
      moment,
      shot,
      feedbackMemory: input.feedbackMemory,
      gameplayReferences: input.gameplayReferencesByShot?.[shot.shotId],
    });
  });
}
