import { createHash } from "node:crypto";
import {
  buildGameplayVideoMotionPlan,
  gameplayAuthenticitySpecFromShot,
} from "./gameplay-authenticity";
import {
  gameplayReferenceLetter,
  gameplayReferencePurposeInstruction,
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

export const GAMEPLAY_PROMPT_COMPILER_VERSION = "gameplay_prompt_compiler_v4";
const GAMEPLAY_PROMPT_SCHEMA_MAX_CHARS = 8_000;
const GAMEPLAY_PROMPT_TARGET_MAX_CHARS = 7_600;

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
  return clippedList(shot.expectedEvidence, { maxItems: 6, maxChars: 220 })
    .map((item, index) => `${index + 1}. ${item}`)
    .join("\n");
}

function compactGameplayReferenceInstructionBlock(
  input: Stage4GameplayReferenceSet | null | undefined,
): string {
  if (!input?.references.length) return "No external gameplay reference images were selected.";

  const refs = input.references.map((item, index) => {
    const reasons = clippedList(item.whySelected, { maxItems: 2, maxChars: 100 }).join("; ");
    return [
      `Reference ${gameplayReferenceLetter(index)} — ${item.purpose.toUpperCase()} — ${clipText(item.gameName, 80)}.`,
      clipText(gameplayReferencePurposeInstruction(item), 230),
      `Gameplay evidence: ${clipText(item.gameplayDescription, 180)}`,
      `Why gameplay: ${clipText(item.whyThisLooksLikeGameplay, 120)}${reasons ? ` Selection: ${reasons}.` : ""}`,
    ].join("\n");
  });

  return `${refs.join("\n\n")}\n\nREFERENCE FIREWALL: use every image only for its labeled purpose. Do not copy game identity, characters, level layout, props, logos, branded UI or the original mechanic. Art direction never overrides player-camera grammar.`;
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
  const mustShow = clippedList(
    [...feedback.mustShow, ...shot.expectedEvidence, ...moment.requiredVisualEvidence],
    { maxItems: 7, maxChars: 180 },
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
  const referenceBlock = compactGameplayReferenceInstructionBlock(gameplayReferences);
  const affordanceBlock = clipText(
    authenticity.gameplayAffordances
      .filter((item) => item.visible && item.meaningful)
      .slice(0, 4)
      .map((item) => `${item.type}: ${clipText(item.informationUsedByPlayer, 140)}`)
      .join("; ") || "No meaningful affordance specified.",
    520,
  );
  const physicsExceptions = authenticity.physics.exceptions.length
    ? clipText(
        authenticity.physics.exceptions
          .slice(0, 4)
          .map(
            (item) =>
              `${clipText(item.entity, 80)}: ${clipText(item.reason, 150)}; visible: ${clipText(item.visualEvidence, 150)}`,
          )
          .join(" | "),
        620,
      )
    : "No unexplained physics exceptions.";

  const imagePrompt = assertPromptBudget(
    "PROMPT_COMPILER_IMAGE",
    `FAKE GAMEPLAY REFERENCE STILL — approval checkpoint before any video generation.\n\nPLAYABLE BEAT:\nConcept: ${clipText(concept.oneSentencePitch, 300)}\nMechanic: ${clipText(concept.coreMechanic, 320)}\nScene: ${clipText(moment.setup, 420)}\n\nPLAYER INPUT -> ACTION -> WORLD RESPONSE:\nControllable player: ${clipText(authenticity.controllablePlayer.role, 120)}; this player must be visually obvious.\nInput: ${clipText(authenticity.playerInput.input, 220)}\nVisible input evidence: ${clipText(authenticity.playerInput.visibleEvidence, 260)}\nAction: ${clipText(authenticity.playerAction.action, 300)}\nTarget: ${clipText(authenticity.playerAction.target, 220)}\nWorld response: ${clipText(authenticity.worldResponse.response, 380)}\n\nPLAYER-BOUND CAMERA:\nCamera type: ${authenticity.camera.type}; physically attached to the controllable player's gameplay viewpoint. ${clipText(authenticity.camera.visibleEvidence, 300)}\nShot framing: ${clipText(shot.camera, 340)}\n\nMEANINGFUL GAMEPLAY AFFORDANCES:\n${affordanceBlock}\n\nCO-OP DEPENDENCY:\n${clipText(authenticity.coop.teammateFunction, 300)}\nVisible evidence: ${clipText(authenticity.coop.visualEvidence, 320)}\n\nPHYSICS CONTRACT:\n${clipText(authenticity.physics.event, 300)}\nAffected: ${clipText(authenticity.physics.affectedEntities.join(", "), 240)}\n${physicsExceptions}\n\nART / READABILITY:\n${clipText(concept.artDirection, 300)}\nStylized indie / AA by default, not photoreal expensive AAA cinematic polish.\n${clipText(concept.readability, 280)}\n\nPURPOSE-LABELED REAL GAMEPLAY REFERENCES:\nThe attached images are ordered exactly as Reference A, B, and so on. Each has a narrow role.\n\n${referenceBlock}\n\nTHE STILL MUST VISIBLY PROVE:\n${mustShow.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\nThis exact image must plausibly be an in-engine PC co-op gameplay screenshot captured while a person is actively playing. It must not read as key art, a trailer frame, a spectator shot, a staged animation or a promotional composition.`,
  );

  const beatBlock = motionPlan.beats
    .map(
      (beat) =>
        `${beat.startSec.toFixed(1)}–${beat.endSec.toFixed(1)} sec — ${clipText(beat.description, 420)}`,
    )
    .join("\n");
  const videoPrompt = assertPromptBudget(
    "PROMPT_COMPILER_VIDEO",
    `Animate the approved gameplay reference still into one continuous 5-second capture of one active gameplay session. Preserve character identities, positions, environment, art direction, interactable objects, meaningful HUD/affordances, and the approved player-camera composition.\n\nHARD CAMERA CONTRACT:\ncamera remains physically attached to the playable character for the entire clip\nNo cinematic reframing, camera orbit, dolly shot, cutaway, dramatic zoom, detached camera, spectator movement, or automatic hero framing.\n\nPLAYABLE 5-SECOND BEAT:\n${beatBlock}\n\nCONTROLLABLE PLAYER INPUT:\n${clipText(authenticity.playerInput.input, 300)}\n\nACTION:\n${clipText(authenticity.playerAction.action, 420)}\n\nWORLD RESPONSE CAUSED BY THAT ACTION:\n${clipText(authenticity.worldResponse.response, 520)}\n\nTEAMMATE DEPENDENCY:\n${clipText(authenticity.coop.teammateFunction, 380)}\n${clipText(authenticity.coop.visualEvidence, 400)}\n\nGAMEPLAY MOMENT HYPOTHESIS:\n${clipText(moment.hypothesis, 420)}\n\nVISIBLE EVIDENCE THAT MUST REMAIN LEGIBLE:\n${evidenceBlock(shot)}\n\nCAMERA:\n${clipText(shot.camera, 500)}\n\nThe result must plausibly be five seconds a player could obtain by pressing Record while actually playing. Do not introduce a new mechanic, new location, camera cut, trailer montage, unrelated spectacle, or character animation that is not a consequence of player input/gameplay state.`,
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
      human_feedback_applied: feedback.mustShow.length + feedback.mustAvoid.length > 0,
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
