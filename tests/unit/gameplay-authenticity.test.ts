import { describe, expect, it } from "vitest";
import {
  buildGameplayVideoMotionPlan,
  evaluateGameplayAuthenticityPlan,
  gameplayAuthenticityPlanV1Schema,
} from "../../lib/game-discovery/gameplay-authenticity";
import type { ShotSpecV1 } from "../../lib/game-discovery/schemas";

function validPlan() {
  return gameplayAuthenticityPlanV1Schema.parse({
    schema: "gameplay_authenticity_plan",
    version: 1,
    shotId: "tilt-shot",
    momentId: "tilt-moment",
    controllablePlayer: {
      role: "cutter",
      obvious: true,
      viewpointPlausiblyPlayable: true,
      scriptedCharactersOnly: false,
    },
    camera: {
      type: "first_person",
      physicallyAttached: true,
      gameplayCameraJustified: true,
      visibleEvidence: "The cutter's held tool and hands anchor the camera to the player.",
    },
    playerInput: {
      input: "hold the cutting trigger",
      visibleEvidence: "The held cutter is active against the clamp in the foreground.",
      visible: true,
    },
    playerAction: {
      action: "The cutter slices through the structural clamp.",
      target: "The highlighted structural clamp supporting the salvage load.",
    },
    worldResponse: {
      response: "The cut releases the support and the shared platform/load begins to tilt and slide.",
      causalResponseVisible: true,
    },
    gameplayAffordances: [
      {
        type: "held_tool",
        visible: true,
        meaningful: true,
        informationUsedByPlayer: "Tool position shows the active cutting target and input state.",
      },
      {
        type: "angle_meter",
        visible: true,
        meaningful: true,
        informationUsedByPlayer: "The player reads platform angle while deciding whether to keep cutting.",
      },
    ],
    coop: {
      dependencyVisible: true,
      teammateFunction: "The teammate braces the shared load while the cutter changes its support state.",
      visualEvidence: "The teammate is within playable distance with hands/brace attached to the same load.",
    },
    physics: {
      event: "Removing support changes platform/load balance for every unsecured entity.",
      consistent: true,
      affectedEntities: ["shared load", "loose salvage", "players"],
      exceptions: [
        {
          entity: "stabilizer",
          reason: "The stabilizer is clipped into a visible safety line while bracing.",
          visualEvidence: "A taut safety line connects the stabilizer to an anchor point.",
        },
      ],
    },
    readability: {
      primaryActionReadable: true,
      visibleGoal: true,
      riskExpected: true,
      visibleRisk: true,
      visualClutter: "low",
    },
  });
}

const shot = {
  shotId: "tilt-shot",
  momentId: "tilt-moment",
  durationSec: 5,
  generationPlan: { durationSec: 5 },
} as unknown as ShotSpecV1;

describe("GameplayAuthenticitySpec v1", () => {
  it("passes a player-bound input -> action -> response co-op shot", () => {
    const spec = evaluateGameplayAuthenticityPlan(validPlan());
    expect(spec.passed).toBe(true);
    expect(spec.hardFailures).toEqual([]);
    expect(spec.scores.playerEmbodiment).toBeGreaterThanOrEqual(0.65);
    expect(spec.scores.cameraAuthenticity).toBeGreaterThanOrEqual(0.75);
    expect(spec.scores.gameplayAffordance).toBe(1);
  });

  it("hard-fails cinematic framing, invisible input and decorative-only HUD before generation", () => {
    const bad = validPlan();
    const spec = evaluateGameplayAuthenticityPlan({
      ...bad,
      camera: {
        ...bad.camera,
        type: "cinematic",
        physicallyAttached: false,
        gameplayCameraJustified: false,
      },
      playerInput: { ...bad.playerInput, visible: false },
      gameplayAffordances: [
        {
          type: "other",
          visible: true,
          meaningful: false,
          informationUsedByPlayer: "Decorative overlay that does not support a player decision.",
        },
      ],
    });
    expect(spec.passed).toBe(false);
    expect(spec.hardFailures).toContain("cinematic_or_detached_camera");
    expect(spec.hardFailures).toContain("camera_not_physically_playable");
    expect(spec.hardFailures).toContain("no_visible_player_input");
    expect(spec.hardFailures).toContain("no_meaningful_gameplay_affordance");
  });

  it("builds a continuous four-beat five-second motion plan with a player-recordability gate", () => {
    const spec = evaluateGameplayAuthenticityPlan(validPlan());
    const motion = buildGameplayVideoMotionPlan(shot, spec);
    expect(motion.passed).toBe(true);
    expect(motion.couldBeRecordedByPlayer).toBe(true);
    expect(motion.beats.map((beat) => [beat.startSec, beat.endSec])).toEqual([
      [0, 1],
      [1, 2.5],
      [2.5, 3.5],
      [3.5, 5],
    ]);
    expect(motion.prohibitedCameraMoves).toContain("detached_camera");
  });

  it("fails the video gate when the image plan itself is not playable", () => {
    const bad = validPlan();
    const spec = evaluateGameplayAuthenticityPlan({
      ...bad,
      controllablePlayer: { ...bad.controllablePlayer, viewpointPlausiblyPlayable: false },
    });
    const motion = buildGameplayVideoMotionPlan(shot, spec);
    expect(motion.passed).toBe(false);
    expect(motion.couldBeRecordedByPlayer).toBe(false);
    expect(motion.gateFailures).toContain("cannot_plausibly_be_recorded_by_active_player");
  });
});
