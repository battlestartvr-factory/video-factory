import { z } from "zod";
import type { ShotSpecV1 } from "./schemas";

const shortText = z.string().trim().min(1).max(1_500);
const evidenceText = z.string().trim().min(1).max(2_000);

export const gameplayCameraTypeV1Schema = z.enum([
  "first_person",
  "third_person_follow",
  "over_shoulder",
  "top_down",
  "fixed_gameplay",
  "cinematic",
  "spectator",
  "drone",
  "marketing_wide",
  "detached_other",
]);

export const gameplayAffordanceTypeV1Schema = z.enum([
  "hands",
  "held_tool",
  "crosshair",
  "interaction_outline",
  "stamina",
  "angle_meter",
  "inventory_hotbar",
  "object_state",
  "contextual_prompt",
  "other",
]);

export const gameplayAuthenticityPlanV1Schema = z
  .object({
    schema: z.literal("gameplay_authenticity_plan"),
    version: z.literal(1),
    shotId: z.string().trim().min(1).max(160),
    momentId: z.string().trim().min(1).max(160),
    controllablePlayer: z
      .object({
        role: shortText,
        obvious: z.boolean(),
        viewpointPlausiblyPlayable: z.boolean(),
        scriptedCharactersOnly: z.boolean().default(false),
      })
      .strict(),
    camera: z
      .object({
        type: gameplayCameraTypeV1Schema,
        physicallyAttached: z.boolean(),
        gameplayCameraJustified: z.boolean(),
        visibleEvidence: evidenceText,
      })
      .strict(),
    playerInput: z
      .object({
        input: shortText,
        visibleEvidence: evidenceText,
        visible: z.boolean(),
      })
      .strict(),
    playerAction: z
      .object({
        action: evidenceText,
        target: evidenceText,
      })
      .strict(),
    worldResponse: z
      .object({
        response: evidenceText,
        causalResponseVisible: z.boolean(),
      })
      .strict(),
    gameplayAffordances: z
      .array(
        z
          .object({
            type: gameplayAffordanceTypeV1Schema,
            visible: z.boolean(),
            meaningful: z.boolean(),
            informationUsedByPlayer: evidenceText,
          })
          .strict(),
      )
      .max(12)
      .default([]),
    coop: z
      .object({
        dependencyVisible: z.boolean(),
        teammateFunction: evidenceText,
        visualEvidence: evidenceText,
      })
      .strict(),
    physics: z
      .object({
        event: evidenceText,
        consistent: z.boolean(),
        affectedEntities: z.array(shortText).min(1).max(20),
        exceptions: z
          .array(
            z
              .object({
                entity: shortText,
                reason: evidenceText,
                visualEvidence: evidenceText,
              })
              .strict(),
          )
          .max(12)
          .default([]),
      })
      .strict(),
    readability: z
      .object({
        primaryActionReadable: z.boolean(),
        visibleGoal: z.boolean(),
        riskExpected: z.boolean(),
        visibleRisk: z.boolean(),
        visualClutter: z.enum(["low", "medium", "high"]),
      })
      .strict(),
  })
  .strict();

export type GameplayAuthenticityPlanV1 = z.infer<typeof gameplayAuthenticityPlanV1Schema>;

export const gameplayAuthenticityHardFailureV1Schema = z.enum([
  "controllable_player_unclear",
  "cinematic_or_detached_camera",
  "camera_not_physically_playable",
  "no_visible_player_input",
  "scripted_characters_only",
  "no_visible_world_response",
  "no_meaningful_gameplay_affordance",
  "coop_dependency_not_visible",
  "impossible_physical_causality",
  "viewpoint_not_plausibly_playable",
  "visual_action_unreadable",
]);

export const gameplayAuthenticityScoresV1Schema = z
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
  .strict();

export const gameplayAuthenticitySpecV1Schema = gameplayAuthenticityPlanV1Schema
  .omit({ schema: true })
  .extend({
    schema: z.literal("gameplay_authenticity"),
    scores: gameplayAuthenticityScoresV1Schema,
    averageScore: z.number().min(0).max(1),
    hardFailures: z.array(gameplayAuthenticityHardFailureV1Schema).max(20),
    passed: z.boolean(),
  })
  .strict();

export type GameplayAuthenticitySpecV1 = z.infer<typeof gameplayAuthenticitySpecV1Schema>;

function round(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clipMotionEvidence(value: string, max = 1_900): string {
  const normalized = value.trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function hasMeaningfulAffordance(plan: GameplayAuthenticityPlanV1): boolean {
  return plan.gameplayAffordances.some(
    (affordance) => affordance.visible && affordance.meaningful && affordance.informationUsedByPlayer.trim(),
  );
}

function playerBoundAffordance(plan: GameplayAuthenticityPlanV1): boolean {
  return plan.gameplayAffordances.some(
    (affordance) =>
      affordance.visible &&
      affordance.meaningful &&
      ["hands", "held_tool", "crosshair", "interaction_outline", "contextual_prompt"].includes(
        affordance.type,
      ),
  );
}

function cameraAllowed(plan: GameplayAuthenticityPlanV1): boolean {
  if (["first_person", "third_person_follow", "over_shoulder"].includes(plan.camera.type)) return true;
  if (["top_down", "fixed_gameplay"].includes(plan.camera.type)) {
    return plan.camera.gameplayCameraJustified;
  }
  return false;
}

export function evaluateGameplayAuthenticityPlan(
  rawPlan: GameplayAuthenticityPlanV1,
): GameplayAuthenticitySpecV1 {
  const plan = gameplayAuthenticityPlanV1Schema.parse(rawPlan);
  const meaningfulAffordance = hasMeaningfulAffordance(plan);
  const allowedCamera = cameraAllowed(plan);
  const validPhysicsExceptions = plan.physics.exceptions.every(
    (item) => item.reason.trim().length > 0 && item.visualEvidence.trim().length > 0,
  );

  const scores = gameplayAuthenticityScoresV1Schema.parse({
    playerEmbodiment: round(
      (plan.controllablePlayer.obvious ? 0.45 : 0) +
        (plan.playerInput.visible ? 0.25 : 0) +
        (plan.controllablePlayer.viewpointPlausiblyPlayable ? 0.15 : 0) +
        (playerBoundAffordance(plan) ? 0.15 : 0),
    ),
    cameraAuthenticity: round(
      (allowedCamera ? 0.55 : 0) +
        (plan.camera.physicallyAttached ? 0.35 : 0) +
        (plan.controllablePlayer.viewpointPlausiblyPlayable ? 0.1 : 0),
    ),
    inputActionClarity: round(
      (plan.playerInput.input.trim() ? 0.25 : 0) +
        (plan.playerInput.visibleEvidence.trim() ? 0.25 : 0) +
        (plan.playerInput.visible ? 0.25 : 0) +
        (plan.playerAction.action.trim() && plan.playerAction.target.trim() ? 0.25 : 0),
    ),
    worldResponseClarity: round(
      (plan.worldResponse.response.trim() ? 0.5 : 0) +
        (plan.worldResponse.causalResponseVisible ? 0.5 : 0),
    ),
    coopReadability: round(
      (plan.coop.dependencyVisible ? 0.5 : 0) +
        (plan.coop.teammateFunction.trim() ? 0.25 : 0) +
        (plan.coop.visualEvidence.trim() ? 0.25 : 0),
    ),
    gameplayAffordance: meaningfulAffordance ? 1 : 0,
    physicalConsistency: round(
      (plan.physics.consistent ? 0.7 : 0) + (validPhysicsExceptions ? 0.3 : 0),
    ),
    visualReadability: round(
      (plan.readability.primaryActionReadable ? 0.45 : 0) +
        (plan.readability.visibleGoal ? 0.25 : 0) +
        (!plan.readability.riskExpected || plan.readability.visibleRisk ? 0.2 : 0) +
        (plan.readability.visualClutter === "low"
          ? 0.1
          : plan.readability.visualClutter === "medium"
            ? 0.05
            : 0),
    ),
  });

  const hardFailures: z.infer<typeof gameplayAuthenticityHardFailureV1Schema>[] = [];
  if (!plan.controllablePlayer.obvious) hardFailures.push("controllable_player_unclear");
  if (!allowedCamera) hardFailures.push("cinematic_or_detached_camera");
  if (!plan.camera.physicallyAttached) hardFailures.push("camera_not_physically_playable");
  if (!plan.playerInput.visible) hardFailures.push("no_visible_player_input");
  if (plan.controllablePlayer.scriptedCharactersOnly) hardFailures.push("scripted_characters_only");
  if (!plan.worldResponse.causalResponseVisible) hardFailures.push("no_visible_world_response");
  if (!meaningfulAffordance) hardFailures.push("no_meaningful_gameplay_affordance");
  if (!plan.coop.dependencyVisible) hardFailures.push("coop_dependency_not_visible");
  if (!plan.physics.consistent || !validPhysicsExceptions) hardFailures.push("impossible_physical_causality");
  if (!plan.controllablePlayer.viewpointPlausiblyPlayable) {
    hardFailures.push("viewpoint_not_plausibly_playable");
  }
  if (!plan.readability.primaryActionReadable) hardFailures.push("visual_action_unreadable");

  const scoreValues = Object.values(scores);
  const averageScore = round(scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length);
  const passed =
    hardFailures.length === 0 &&
    averageScore >= 0.72 &&
    scores.playerEmbodiment >= 0.65 &&
    scores.cameraAuthenticity >= 0.75 &&
    scores.inputActionClarity >= 0.75 &&
    scores.worldResponseClarity >= 0.75 &&
    scores.gameplayAffordance >= 0.75 &&
    scores.physicalConsistency >= 0.7 &&
    scores.visualReadability >= 0.65;

  return gameplayAuthenticitySpecV1Schema.parse({
    ...plan,
    schema: "gameplay_authenticity",
    scores,
    averageScore,
    hardFailures,
    passed,
  });
}

export function gameplayAuthenticityPlanFromShot(shot: ShotSpecV1): GameplayAuthenticityPlanV1 {
  const metadata = shot.metadata ?? {};
  return gameplayAuthenticityPlanV1Schema.parse(metadata.gameplayAuthenticityPlan);
}

export function gameplayAuthenticitySpecFromShot(shot: ShotSpecV1): GameplayAuthenticitySpecV1 {
  const metadata = shot.metadata ?? {};
  const persisted = gameplayAuthenticitySpecV1Schema.safeParse(metadata.gameplayAuthenticity);
  if (persisted.success) return persisted.data;
  return evaluateGameplayAuthenticityPlan(gameplayAuthenticityPlanFromShot(shot));
}

export function attachGameplayAuthenticitySpec(shot: ShotSpecV1): ShotSpecV1 {
  const plan = gameplayAuthenticityPlanFromShot(shot);
  const spec = evaluateGameplayAuthenticityPlan(plan);
  return {
    ...shot,
    metadata: {
      ...(shot.metadata ?? {}),
      gameplayAuthenticityPlan: plan,
      gameplayAuthenticity: spec,
    },
  };
}

export const gameplayMotionBeatV1Schema = z
  .object({
    startSec: z.number().min(0).max(15),
    endSec: z.number().min(0).max(15),
    kind: z.enum(["aim_or_prepare", "player_action", "world_response", "player_adjustment"]),
    description: evidenceText,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.endSec <= value.startSec) {
      ctx.addIssue({ code: "custom", path: ["endSec"], message: "beat endSec must exceed startSec" });
    }
  });

export const gameplayVideoMotionPlanV1Schema = z
  .object({
    schema: z.literal("gameplay_video_motion_plan"),
    version: z.literal(1),
    shotId: z.string().trim().min(1).max(160),
    durationSec: z.number().min(3).max(15),
    cameraRemainsPhysicallyAttached: z.literal(true),
    prohibitedCameraMoves: z
      .array(
        z.enum([
          "cinematic_reframing",
          "camera_orbit",
          "dolly_shot",
          "cutaway",
          "dramatic_zoom",
          "detached_camera",
        ]),
      )
      .min(6)
      .max(6),
    beats: z.array(gameplayMotionBeatV1Schema).length(4),
    couldBeRecordedByPlayer: z.boolean(),
    gateFailures: z.array(shortText).max(20).default([]),
    passed: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.beats[0]?.startSec !== 0) {
      ctx.addIssue({ code: "custom", path: ["beats", 0, "startSec"], message: "motion plan must start at zero" });
    }
    if (Math.abs((value.beats.at(-1)?.endSec ?? -1) - value.durationSec) > 0.001) {
      ctx.addIssue({ code: "custom", path: ["beats"], message: "motion plan must fill the entire shot duration" });
    }
  });

export type GameplayVideoMotionPlanV1 = z.infer<typeof gameplayVideoMotionPlanV1Schema>;

export function buildGameplayVideoMotionPlan(
  shot: ShotSpecV1,
  authenticity: GameplayAuthenticitySpecV1 = gameplayAuthenticitySpecFromShot(shot),
): GameplayVideoMotionPlanV1 {
  const failures: string[] = [];
  const durationSec = shot.durationSec;
  if (!authenticity.passed) failures.push("pre_image_authenticity_not_passed");
  if (!authenticity.camera.physicallyAttached) failures.push("camera_not_physically_attached");
  if (!authenticity.playerInput.visible) failures.push("player_input_not_visible");
  if (!authenticity.worldResponse.causalResponseVisible) failures.push("world_response_not_causal");
  if (Math.abs(shot.generationPlan.durationSec - durationSec) > 0.001) {
    failures.push("generation_duration_mismatch");
  }

  const couldBeRecordedByPlayer =
    failures.length === 0 &&
    authenticity.controllablePlayer.viewpointPlausiblyPlayable &&
    !authenticity.controllablePlayer.scriptedCharactersOnly;
  if (!couldBeRecordedByPlayer) failures.push("cannot_plausibly_be_recorded_by_active_player");

  const boundary1 = roundSeconds(durationSec * 0.2);
  const boundary2 = roundSeconds(durationSec * 0.5);
  const boundary3 = roundSeconds(durationSec * 0.7);

  return gameplayVideoMotionPlanV1Schema.parse({
    schema: "gameplay_video_motion_plan",
    version: 1,
    shotId: shot.shotId,
    durationSec,
    cameraRemainsPhysicallyAttached: true,
    prohibitedCameraMoves: [
      "cinematic_reframing",
      "camera_orbit",
      "dolly_shot",
      "cutaway",
      "dramatic_zoom",
      "detached_camera",
    ],
    beats: [
      {
        startSec: 0,
        endSec: boundary1,
        kind: "aim_or_prepare",
        description: clipMotionEvidence(
          `Player prepares the input ${authenticity.playerInput.input}; visible evidence: ${authenticity.playerInput.visibleEvidence}`,
        ),
      },
      {
        startSec: boundary1,
        endSec: boundary2,
        kind: "player_action",
        description: clipMotionEvidence(authenticity.playerAction.action),
      },
      {
        startSec: boundary2,
        endSec: boundary3,
        kind: "world_response",
        description: clipMotionEvidence(authenticity.worldResponse.response),
      },
      {
        startSec: boundary3,
        endSec: durationSec,
        kind: "player_adjustment",
        description: clipMotionEvidence(
          `Playable adjustment/recovery while teammate function remains visible: ${authenticity.coop.teammateFunction}`,
        ),
      },
    ],
    couldBeRecordedByPlayer,
    gateFailures: [...new Set(failures)],
    passed: couldBeRecordedByPlayer && failures.length === 0,
  });
}