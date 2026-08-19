import { describe, expect, it } from "vitest";
import {
  evaluateGameplayImageAuthenticityInspection,
  evaluateGameplayVideoAuthenticityInspection,
  gameplayAuthenticityFeedbackFromImageInspection,
} from "../../lib/game-discovery/gameplay-authenticity-inspection";
import { evaluateGameplayAuthenticityPlan } from "../../lib/game-discovery/gameplay-authenticity";

const planned = evaluateGameplayAuthenticityPlan({
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
    visibleEvidence: "Hands and cutter are in the foreground.",
  },
  playerInput: {
    input: "hold cutting trigger",
    visibleEvidence: "Active cutter contacts the clamp.",
    visible: true,
  },
  playerAction: { action: "cut the clamp", target: "structural clamp" },
  worldResponse: {
    response: "support releases and the shared load tilts",
    causalResponseVisible: true,
  },
  gameplayAffordances: [
    {
      type: "held_tool",
      visible: true,
      meaningful: true,
      informationUsedByPlayer: "Tool contact indicates the active cut target.",
    },
  ],
  coop: {
    dependencyVisible: true,
    teammateFunction: "stabilizer braces the same load",
    visualEvidence: "teammate hands/brace contact the shared load",
  },
  physics: {
    event: "load tilts when support is cut",
    consistent: true,
    affectedEntities: ["load", "loose salvage"],
    exceptions: [],
  },
  readability: {
    primaryActionReadable: true,
    visibleGoal: true,
    riskExpected: true,
    visibleRisk: true,
    visualClutter: "low",
  },
});

function imageObservation() {
  return {
    couldBeActiveGameplayScreenshot: true,
    controllablePlayerObvious: true,
    controllablePlayerLocation: "First-person hands and cutting tool occupy the lower foreground.",
    currentPlayerAction: "The player cuts the structural clamp.",
    probablePlayerInput: "The player is holding the tool trigger.",
    playerInputInferable: true,
    worldResponse: "The support releases and the load begins tilting.",
    worldResponseVisible: true,
    cameraPhysicallyPlausible: true,
    cinematicOrPromotional: false,
    gameplayAffordanceVisible: true,
    hudPresent: false,
    hudMeaningfulIfPresent: true,
    teammateDependencyVisible: true,
    physicsConsistent: true,
    primaryActionReadable: true,
    matchesPlannedComposition: true,
    defects: [],
  };
}

describe("generated gameplay authenticity inspections", () => {
  it("passes a generated reference that visibly reads as active gameplay", () => {
    const inspection = evaluateGameplayImageAuthenticityInspection({
      generationId: "generation-image-1",
      shotId: "tilt-shot",
      observation: imageObservation(),
      inspectorModel: "gemini-3-6-flash",
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    });
    expect(inspection.passed).toBe(true);
    expect(inspection.hardFailures).toEqual([]);
  });

  it("turns a cinematic generated image into concrete automatic revision constraints", () => {
    const inspection = evaluateGameplayImageAuthenticityInspection({
      generationId: "generation-image-2",
      shotId: "tilt-shot",
      observation: {
        ...imageObservation(),
        couldBeActiveGameplayScreenshot: false,
        controllablePlayerObvious: false,
        playerInputInferable: false,
        cameraPhysicallyPlausible: false,
        cinematicOrPromotional: true,
        gameplayAffordanceVisible: false,
      },
      inspectorModel: "gemini-3-6-flash",
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    });
    expect(inspection.passed).toBe(false);
    expect(inspection.hardFailures).toContain("cinematic_or_detached_camera");
    const feedback = gameplayAuthenticityFeedbackFromImageInspection(inspection);
    expect(feedback.errorTags).toContain("gameplay_authenticity_failure");
    expect(feedback.mustShow.join(" ")).toContain("controllable player");
    expect(feedback.mustAvoid.join(" ")).toContain("cinematic");
  });

  it("blocks sampled video continuity defects before asset graph/assembly", () => {
    const inspection = evaluateGameplayVideoAuthenticityInspection({
      generationId: "generation-video-1",
      shotId: "tilt-shot",
      sampledFrameCount: 5,
      plannedAuthenticity: planned,
      inspectorModel: "gemini-3-6-flash",
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      observation: {
        couldBeContinuousGameplayCapture: false,
        cameraContinuous: false,
        cameraPhysicallyAttachedThroughout: false,
        cinematicCameraMovement: true,
        handsOrToolsExpected: true,
        handsToolsStableIfExpected: false,
        hudPresent: false,
        hudStableIfPresent: true,
        teammateVisibleOrImplied: true,
        teammateIdentityStable: false,
        physicsConsistent: false,
        objectTeleportation: true,
        actionsTrackVisiblePlayerInput: false,
        actorsBehaveLikePlayers: false,
        referenceCompositionPreserved: false,
        worldResponseContinuous: false,
        defects: ["camera becomes a detached orbit and the cutting tool disappears"],
      },
    });
    expect(inspection.passed).toBe(false);
    expect(inspection.hardFailures).toContain("camera_detached_or_discontinuous");
    expect(inspection.hardFailures).toContain("object_teleportation");
    expect(inspection.hardFailures).toContain("characters_behave_like_actors");
  });
});
