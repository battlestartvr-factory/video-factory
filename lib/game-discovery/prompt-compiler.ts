import { createHash } from "node:crypto";
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

export const GAMEPLAY_PROMPT_COMPILER_VERSION = "gameplay_prompt_compiler_v2";

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
    ...feedback.mustAvoid,
    ...feedback.errorTags.map((tag) => `do not repeat rejected error pattern: ${tag}`),
  ]);
  const referenceBlock = renderGameplayReferenceInstructionBlock(gameplayReferences);

  const imagePrompt = `FAKE GAMEPLAY REFERENCE STILL — approval checkpoint before any video generation.\n\nGAME CONCEPT:\n${concept.oneSentencePitch}\n\nCORE MECHANIC:\n${concept.coreMechanic}\n\nCO-OP DEPENDENCY:\n${concept.coopDependency}\n\nSCENE SETUP:\n${moment.setup}\n\nSHOT ACTION:\n${shot.action}\n\nVISIBLE ACTORS:\n${shot.actors.join(", ")}\n\nCAMERA / GAMEPLAY FRAMING:\n${shot.camera}\n\nENVIRONMENT:\n${shot.environment}\n\nART DIRECTION:\n${concept.artDirection}\n\nREADABILITY REQUIREMENT:\n${concept.readability}\n\nPURPOSE-LABELED REAL GAMEPLAY REFERENCES:\nThe attached reference images are ordered exactly as Reference A, Reference B, and so on below. Each image has a narrow role. Respect the role firewall.\n\n${referenceBlock}\n\nTHE STILL MUST VISIBLY PROVE:\n${mustShow.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\nMake this look like a plausible in-engine PC co-op gameplay screenshot captured while a person is actively playing, not key art, a trailer frame, a spectator shot, or a promotional composition. The viewer should understand who they control, what input-driven action is occurring, why the teammate matters, and what the world is doing in response.`;

  const videoPrompt = `Animate the approved gameplay reference still into one continuous ${shot.durationSec}-second fake-gameplay shot. Preserve character identities, positions, environment, art direction, interactable objects, and camera logic from the approved reference image.\n\nACTION:\n${shot.action}\n\nGAMEPLAY MOMENT HYPOTHESIS:\n${moment.hypothesis}\n\nCO-OP DEPENDENCY EVIDENCE:\n${moment.coopDependencyEvidence}\n\nSOCIAL TENSION:\n${moment.socialTension}\n\nVISIBLE EVIDENCE THAT MUST REMAIN LEGIBLE:\n${evidenceBlock(shot)}\n\nCAMERA:\n${shot.camera}\n\nDo not introduce a new mechanic, new location, camera cut, trailer montage, or unrelated spectacle. The purpose is to test whether the mechanic reads as gameplay.`;

  const compilerInputsHash = stableHash({
    compiler: GAMEPLAY_PROMPT_COMPILER_VERSION,
    concept,
    moment,
    shot,
    feedback,
    gameplayReferences: gameplayReferences ?? null,
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
