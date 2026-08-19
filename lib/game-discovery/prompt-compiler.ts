import { createHash } from "node:crypto";
import {
  buildGameplayVideoMotionPlan,
  gameplayAuthenticitySpecFromShot,
} from "./gameplay-authenticity";
import {
  renderGameplayReferenceInstructionBlock,
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

export const GAMEPLAY_PROMPT_COMPILER_VERSION = "gameplay_prompt_compiler_v3";

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function clean(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function evidenceBlock(shot: ShotSpecV1): string {
  return shot.expectedEvidence.map((item, index) => `${index + 1}. ${item}`).join("\n");
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

  const mustShow = clean([
    ...moment.requiredVisualEvidence,
    ...shot.expectedEvidence,
    ...feedback.mustShow,
  ]);
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
  const referenceBlock = renderGameplayReferenceInstructionBlock(gameplayReferences);
  const affordanceBlock = authenticity.gameplayAffordances
    .filter((item) => item.visible && item.meaningful)
    .map((item) => `${item.type}: ${item.informationUsedByPlayer}`)
    .join("\n");

  const imagePrompt = `FAKE GAMEPLAY REFERENCE STILL — approval checkpoint before any video generation.\n\nGAME CONCEPT:\n${concept.oneSentencePitch}\n\nCORE MECHANIC:\n${concept.coreMechanic}\n\nCO-OP DEPENDENCY:\n${concept.coopDependency}\n\nSCENE SETUP:\n${moment.setup}\n\nSHOT ACTION:\n${shot.action}\n\nCONTROLLABLE PLAYER:\n${authenticity.controllablePlayer.role}. This player must be visually obvious from a plausible gameplay viewpoint.\n\nPLAYER INPUT -> ACTION -> WORLD RESPONSE:\nINPUT: ${authenticity.playerInput.input}\nVISIBLE INPUT EVIDENCE: ${authenticity.playerInput.visibleEvidence}\nPLAYER ACTION: ${authenticity.playerAction.action}\nTARGET: ${authenticity.playerAction.target}\nWORLD RESPONSE: ${authenticity.worldResponse.response}\n\nMEANINGFUL GAMEPLAY AFFORDANCES:\n${affordanceBlock}\n\nCO-OP FUNCTION:\n${authenticity.coop.teammateFunction}\nVISIBLE CO-OP EVIDENCE: ${authenticity.coop.visualEvidence}\n\nPHYSICS CONTRACT:\n${authenticity.physics.event}\nAffected entities: ${authenticity.physics.affectedEntities.join(", ")}\n${authenticity.physics.exceptions.length ? `Visually explained exceptions: ${authenticity.physics.exceptions.map((item) => `${item.entity}: ${item.reason}; visible evidence: ${item.visualEvidence}`).join(" | ")}` : "No unexplained physics exceptions."}\n\nVISIBLE ACTORS:\n${shot.actors.join(", ")}\n\nCAMERA / GAMEPLAY FRAMING:\n${shot.camera}\nCamera type: ${authenticity.camera.type}; it is physically attached to the controllable player's gameplay viewpoint. Evidence: ${authenticity.camera.visibleEvidence}\n\nENVIRONMENT:\n${shot.environment}\n\nART DIRECTION:\n${concept.artDirection}\nDefault visual target is stylized indie / AA, not photoreal expensive AAA cinematic polish unless the concept explicitly requires otherwise.\n\nREADABILITY REQUIREMENT:\n${concept.readability}\n\nPURPOSE-LABELED REAL GAMEPLAY REFERENCES:\nThe attached reference images are ordered exactly as Reference A, Reference B, and so on below. Each image has a narrow role. Respect the role firewall.\n\n${referenceBlock}\n\nTHE STILL MUST VISIBLY PROVE:\n${mustShow.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\nMake this exact image plausibly look like an in-engine PC co-op gameplay screenshot captured while a person is actively playing. It must not read as key art, a trailer frame, a spectator shot, a staged animation, or a promotional composition.`;

  const beatBlock = motionPlan.beats
    .map((beat) => `${beat.startSec.toFixed(1)}–${beat.endSec.toFixed(1)} sec — ${beat.description}`)
    .join("\n");
  const videoPrompt = `Animate the approved gameplay reference still into one continuous 5-second capture of one active gameplay session. Preserve character identities, positions, environment, art direction, interactable objects, meaningful HUD/affordances, and the approved player-camera composition.\n\nHARD CAMERA CONTRACT:\ncamera remains physically attached to the playable character for the entire clip\nNo cinematic reframing, camera orbit, dolly shot, cutaway, dramatic zoom, detached camera, spectator movement, or automatic hero framing.\n\nPLAYABLE 5-SECOND BEAT:\n${beatBlock}\n\nCONTROLLABLE PLAYER INPUT:\n${authenticity.playerInput.input}\n\nACTION:\n${authenticity.playerAction.action}\n\nWORLD RESPONSE CAUSED BY THAT ACTION:\n${authenticity.worldResponse.response}\n\nTEAMMATE DEPENDENCY:\n${authenticity.coop.teammateFunction}\n${authenticity.coop.visualEvidence}\n\nGAMEPLAY MOMENT HYPOTHESIS:\n${moment.hypothesis}\n\nVISIBLE EVIDENCE THAT MUST REMAIN LEGIBLE:\n${evidenceBlock(shot)}\n\nCAMERA:\n${shot.camera}\n\nThe result must plausibly be five seconds a player could obtain by pressing Record while actually playing. Do not introduce a new mechanic, new location, camera cut, trailer montage, unrelated spectacle, or character animation that is not a consequence of player input/gameplay state.`;

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
