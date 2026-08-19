import { z } from "zod";
import type { GameplayAuthenticitySpecV1 } from "./gameplay-authenticity";

const evidence = z.string().trim().min(1).max(2_000);
const defect = z.string().trim().min(1).max(500);

export const gameplayImageAuthenticityObservationV1Schema = z
  .object({
    couldBeActiveGameplayScreenshot: z.boolean(),
    controllablePlayerObvious: z.boolean(),
    controllablePlayerLocation: evidence,
    currentPlayerAction: evidence,
    probablePlayerInput: evidence,
    playerInputInferable: z.boolean(),
    worldResponse: evidence,
    worldResponseVisible: z.boolean(),
    cameraPhysicallyPlausible: z.boolean(),
    cinematicOrPromotional: z.boolean(),
    gameplayAffordanceVisible: z.boolean(),
    hudPresent: z.boolean(),
    hudMeaningfulIfPresent: z.boolean(),
    teammateDependencyVisible: z.boolean(),
    physicsConsistent: z.boolean(),
    primaryActionReadable: z.boolean(),
    matchesPlannedComposition: z.boolean(),
    defects: z.array(defect).max(20).default([]),
  })
  .strict();

export type GameplayImageAuthenticityObservationV1 = z.infer<
  typeof gameplayImageAuthenticityObservationV1Schema
>;

export const gameplayImageAuthenticityInspectionV1Schema = z
  .object({
    schema: z.literal("gameplay_image_authenticity_inspection"),
    version: z.literal(1),
    generationId: z.string().trim().min(1).max(160),
    shotId: z.string().trim().min(1).max(160),
    observation: gameplayImageAuthenticityObservationV1Schema,
    scores: z
      .object({
        playerEmbodiment: z.number().min(0).max(1),
        cameraAuthenticity: z.number().min(0).max(1),
        inputActionClarity: z.number().min(0).max(1),
        worldResponseClarity: z.number().min(0).max(1),
        coopReadability: z.number().min(0).max(1),
        gameplayAffordance: z.number().min(0).max(1),
        physicalConsistency: z.number().min(0).max(1),
        visualReadability: z.number().min(0).max(1),
      })
      .strict(),
    averageScore: z.number().min(0).max(1),
    hardFailures: z.array(defect).max(30),
    passed: z.boolean(),
    inspectorModel: z.string().trim().min(1).max(160),
    usage: z
      .object({
        promptTokens: z.number().int().nonnegative(),
        completionTokens: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
        modelCalls: z.literal(1),
      })
      .strict(),
  })
  .strict();

export type GameplayImageAuthenticityInspectionV1 = z.infer<
  typeof gameplayImageAuthenticityInspectionV1Schema
>;

export const gameplayVideoAuthenticityObservationV1Schema = z
  .object({
    couldBeContinuousGameplayCapture: z.boolean(),
    cameraContinuous: z.boolean(),
    cameraPhysicallyAttachedThroughout: z.boolean(),
    cinematicCameraMovement: z.boolean(),
    handsOrToolsExpected: z.boolean(),
    handsToolsStableIfExpected: z.boolean(),
    hudPresent: z.boolean(),
    hudStableIfPresent: z.boolean(),
    teammateVisibleOrImplied: z.boolean(),
    teammateIdentityStable: z.boolean(),
    physicsConsistent: z.boolean(),
    objectTeleportation: z.boolean(),
    actionsTrackVisiblePlayerInput: z.boolean(),
    actorsBehaveLikePlayers: z.boolean(),
    referenceCompositionPreserved: z.boolean(),
    worldResponseContinuous: z.boolean(),
    defects: z.array(defect).max(30).default([]),
  })
  .strict();

export type GameplayVideoAuthenticityObservationV1 = z.infer<
  typeof gameplayVideoAuthenticityObservationV1Schema
>;

export const gameplayVideoAuthenticityInspectionV1Schema = z
  .object({
    schema: z.literal("gameplay_video_authenticity_inspection"),
    version: z.literal(1),
    generationId: z.string().trim().min(1).max(160),
    shotId: z.string().trim().min(1).max(160),
    sampledFrameCount: z.number().int().min(2).max(8),
    observation: gameplayVideoAuthenticityObservationV1Schema,
    scores: z
      .object({
        cameraContinuity: z.number().min(0).max(1),
        playerInputContinuity: z.number().min(0).max(1),
        affordanceContinuity: z.number().min(0).max(1),
        teammateContinuity: z.number().min(0).max(1),
        physicalConsistency: z.number().min(0).max(1),
        worldResponseContinuity: z.number().min(0).max(1),
        compositionPreservation: z.number().min(0).max(1),
        gameplayBehavior: z.number().min(0).max(1),
      })
      .strict(),
    averageScore: z.number().min(0).max(1),
    hardFailures: z.array(defect).max(30),
    passed: z.boolean(),
    inspectorModel: z.string().trim().min(1).max(160),
    usage: z
      .object({
        promptTokens: z.number().int().nonnegative(),
        completionTokens: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
        modelCalls: z.literal(1),
      })
      .strict(),
  })
  .strict();

export type GameplayVideoAuthenticityInspectionV1 = z.infer<
  typeof gameplayVideoAuthenticityInspectionV1Schema
>;

function round(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

function mean(values: number[]): number {
  return round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length));
}

export function evaluateGameplayImageAuthenticityInspection(input: {
  generationId: string;
  shotId: string;
  observation: GameplayImageAuthenticityObservationV1;
  inspectorModel: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}): GameplayImageAuthenticityInspectionV1 {
  const o = gameplayImageAuthenticityObservationV1Schema.parse(input.observation);
  const hudOkay = !o.hudPresent || o.hudMeaningfulIfPresent;
  const scores = {
    playerEmbodiment: round((o.controllablePlayerObvious ? 0.6 : 0) + (o.playerInputInferable ? 0.4 : 0)),
    cameraAuthenticity: round(
      (o.cameraPhysicallyPlausible ? 0.65 : 0) + (!o.cinematicOrPromotional ? 0.35 : 0),
    ),
    inputActionClarity: round((o.playerInputInferable ? 0.55 : 0) + (o.primaryActionReadable ? 0.45 : 0)),
    worldResponseClarity: o.worldResponseVisible ? 1 : 0,
    coopReadability: o.teammateDependencyVisible ? 1 : 0,
    gameplayAffordance: o.gameplayAffordanceVisible && hudOkay ? 1 : 0,
    physicalConsistency: o.physicsConsistent ? 1 : 0,
    visualReadability: round((o.primaryActionReadable ? 0.6 : 0) + (o.matchesPlannedComposition ? 0.4 : 0)),
  };
  const hardFailures: string[] = [];
  if (!o.couldBeActiveGameplayScreenshot) hardFailures.push("not_plausible_active_gameplay_screenshot");
  if (!o.controllablePlayerObvious) hardFailures.push("controllable_player_unclear");
  if (!o.cameraPhysicallyPlausible || o.cinematicOrPromotional) {
    hardFailures.push("cinematic_or_detached_camera");
  }
  if (!o.playerInputInferable) hardFailures.push("player_input_not_inferable");
  if (!o.worldResponseVisible) hardFailures.push("world_response_not_visible");
  if (!o.gameplayAffordanceVisible || !hudOkay) hardFailures.push("meaningful_gameplay_affordance_missing");
  if (!o.teammateDependencyVisible) hardFailures.push("coop_dependency_not_visible");
  if (!o.physicsConsistent) hardFailures.push("physics_inconsistent");
  if (!o.primaryActionReadable) hardFailures.push("primary_action_unreadable");
  if (!o.matchesPlannedComposition) hardFailures.push("planned_composition_not_preserved");

  const averageScore = mean(Object.values(scores));
  const passed =
    hardFailures.length === 0 &&
    averageScore >= 0.78 &&
    scores.cameraAuthenticity >= 0.75 &&
    scores.playerEmbodiment >= 0.7 &&
    scores.inputActionClarity >= 0.75 &&
    scores.gameplayAffordance >= 0.75;

  return gameplayImageAuthenticityInspectionV1Schema.parse({
    schema: "gameplay_image_authenticity_inspection",
    version: 1,
    generationId: input.generationId,
    shotId: input.shotId,
    observation: o,
    scores,
    averageScore,
    hardFailures: [...new Set(hardFailures)],
    passed,
    inspectorModel: input.inspectorModel,
    usage: { ...input.usage, modelCalls: 1 },
  });
}

export function evaluateGameplayVideoAuthenticityInspection(input: {
  generationId: string;
  shotId: string;
  sampledFrameCount: number;
  observation: GameplayVideoAuthenticityObservationV1;
  plannedAuthenticity: GameplayAuthenticitySpecV1;
  inspectorModel: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}): GameplayVideoAuthenticityInspectionV1 {
  const o = gameplayVideoAuthenticityObservationV1Schema.parse(input.observation);
  const affordanceExpected = input.plannedAuthenticity.gameplayAffordances.some(
    (item) => item.visible && item.meaningful,
  );
  const affordanceStable =
    (!o.handsOrToolsExpected || o.handsToolsStableIfExpected) &&
    (!o.hudPresent || o.hudStableIfPresent);
  const scores = {
    cameraContinuity: round(
      (o.cameraContinuous ? 0.4 : 0) +
        (o.cameraPhysicallyAttachedThroughout ? 0.4 : 0) +
        (!o.cinematicCameraMovement ? 0.2 : 0),
    ),
    playerInputContinuity: o.actionsTrackVisiblePlayerInput ? 1 : 0,
    affordanceContinuity: affordanceExpected ? (affordanceStable ? 1 : 0) : 1,
    teammateContinuity: o.teammateVisibleOrImplied && o.teammateIdentityStable ? 1 : 0,
    physicalConsistency: o.physicsConsistent && !o.objectTeleportation ? 1 : 0,
    worldResponseContinuity: o.worldResponseContinuous ? 1 : 0,
    compositionPreservation: o.referenceCompositionPreserved ? 1 : 0,
    gameplayBehavior: o.actorsBehaveLikePlayers && o.couldBeContinuousGameplayCapture ? 1 : 0,
  };
  const hardFailures: string[] = [];
  if (!o.couldBeContinuousGameplayCapture) hardFailures.push("not_plausible_continuous_gameplay_capture");
  if (!o.cameraContinuous || !o.cameraPhysicallyAttachedThroughout) hardFailures.push("camera_detached_or_discontinuous");
  if (o.cinematicCameraMovement) hardFailures.push("cinematic_camera_movement");
  if (affordanceExpected && !affordanceStable) hardFailures.push("hands_tools_or_hud_drift");
  if (!o.teammateVisibleOrImplied || !o.teammateIdentityStable) hardFailures.push("teammate_identity_or_dependency_drift");
  if (!o.physicsConsistent) hardFailures.push("physics_inconsistent");
  if (o.objectTeleportation) hardFailures.push("object_teleportation");
  if (!o.actionsTrackVisiblePlayerInput) hardFailures.push("actions_without_visible_player_input");
  if (!o.actorsBehaveLikePlayers) hardFailures.push("characters_behave_like_actors");
  if (!o.referenceCompositionPreserved) hardFailures.push("reference_composition_not_preserved");
  if (!o.worldResponseContinuous) hardFailures.push("world_response_continuity_broken");

  const averageScore = mean(Object.values(scores));
  const passed = hardFailures.length === 0 && averageScore >= 0.8 && scores.cameraContinuity >= 0.8;
  return gameplayVideoAuthenticityInspectionV1Schema.parse({
    schema: "gameplay_video_authenticity_inspection",
    version: 1,
    generationId: input.generationId,
    shotId: input.shotId,
    sampledFrameCount: input.sampledFrameCount,
    observation: o,
    scores,
    averageScore,
    hardFailures: [...new Set(hardFailures)],
    passed,
    inspectorModel: input.inspectorModel,
    usage: { ...input.usage, modelCalls: 1 },
  });
}

export function gameplayAuthenticityFeedbackFromImageInspection(
  inspection: GameplayImageAuthenticityInspectionV1,
): { errorTags: string[]; mustShow: string[]; mustAvoid: string[] } {
  const errorTags = ["gameplay_authenticity_failure", ...inspection.hardFailures];
  const mustShow = new Set<string>();
  const mustAvoid = new Set<string>();
  for (const failure of inspection.hardFailures) {
    switch (failure) {
      case "not_plausible_active_gameplay_screenshot":
        mustShow.add("The next frame must be immediately plausible as a screenshot captured during active PC gameplay.");
        break;
      case "controllable_player_unclear":
        mustShow.add("Make the controllable player obvious through player-bound camera/body/hands/tool evidence.");
        break;
      case "cinematic_or_detached_camera":
        mustShow.add("Keep the camera physically attached to the controllable player at normal gameplay distance.");
        mustAvoid.add("cinematic, spectator, drone, marketing-wide, dolly or detached observer composition");
        break;
      case "player_input_not_inferable":
        mustShow.add("Show an input-driven player action with a visible held control/tool/affordance that makes the input inferable.");
        break;
      case "world_response_not_visible":
        mustShow.add("Show the immediate world-state change caused by the player's visible action in the same frame.");
        break;
      case "meaningful_gameplay_affordance_missing":
        mustShow.add("Include at least one meaningful gameplay affordance that directly informs the current player action.");
        mustAvoid.add("decorative HUD or UI that carries no information used by the player");
        break;
      case "coop_dependency_not_visible":
        mustShow.add("Make the teammate's mechanically dependent function visible without widening into a promotional team shot.");
        break;
      case "physics_inconsistent":
        mustShow.add("Apply the same physics event consistently to all unsecured entities or visibly show each anchor/harness/clamp exception.");
        break;
      case "primary_action_unreadable":
        mustShow.add("Make the controllable player's primary action and target readable without narration.");
        break;
      case "planned_composition_not_preserved":
        mustShow.add("Preserve the planned player-camera, interaction target and teammate placement instead of reframing for spectacle.");
        break;
    }
  }
  return { errorTags: [...new Set(errorTags)], mustShow: [...mustShow], mustAvoid: [...mustAvoid] };
}
