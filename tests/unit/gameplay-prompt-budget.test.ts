import { describe, expect, it } from "vitest";
import { compileGameplayPromptPlan } from "../../lib/game-discovery/prompt-compiler";
import type { Stage4GameplayReferenceSet } from "../../lib/game-discovery/gameplay-reference-stage4";
import type {
  CoopGameConceptSpecV1,
  GameplayMomentSpecV1,
  ShotSpecV1,
} from "../../lib/game-discovery/schemas";

const long = (label: string, length: number) => `${label} ${"detail ".repeat(Math.ceil(length / 7))}`.slice(0, length);

function concept(): CoopGameConceptSpecV1 {
  return {
    schema: "coop_game_concept",
    version: 1,
    conceptId: "tilt-salvage-test",
    oneSentencePitch: long("Pitch", 500),
    coreMechanic: long("Core mechanic", 2_000),
    coopDependency: long("Co-op dependency", 2_000),
    playerRoles: [
      { role: "Cutter", responsibility: long("Cuts the load", 900) },
      { role: "Counter-Weight", responsibility: long("Balances the platform", 900) },
    ],
    playerCount: { min: 2, max: 4, ideal: 3 },
    interactionModel: ["physics_sync", "shared_liability"],
    failureMode: long("Failure", 1_900),
    socialMoment: long("Social moment", 1_900),
    gameplayHook: long("Hook", 1_400),
    spectacle: long("Spectacle", 1_400),
    setting: long("Setting", 1_400),
    artDirection: long("Stylized indie industrial", 1_400),
    camera: long("Third-person follow", 900),
    readability: long("Readable action and risk", 1_400),
    noveltyAxes: [
      { axis: "risk", choice: "mass balance", whyDifferent: long("Different risk", 900) },
      { axis: "space", choice: "subtractive platform", whyDifferent: long("Different space", 900) },
    ],
    buildability: {
      networking: "medium",
      physics: "high",
      contentBurden: "low",
      npcAiDependency: "none",
      systemicInteractions: "high",
      mainRisks: ["network physics", "movement tuning"],
      mvpRead: long("MVP", 1_900),
    },
    referenceInfluences: [],
    metadata: {},
  };
}

function moment(): GameplayMomentSpecV1 {
  return {
    schema: "gameplay_moment",
    version: 1,
    momentId: "tilt-salvage-test-moment",
    conceptId: "tilt-salvage-test",
    hypothesis: long("Input should visibly change the world", 1_900),
    durationTargetSec: 5,
    setup: long("The level platform and engine block are visible", 1_900),
    playerActions: [
      {
        role: "Cutter",
        action: long("Holds the cutting input", 1_400),
        dependencyOnOthers: long("Needs the teammate to counterbalance", 1_400),
      },
      {
        role: "Counter-Weight",
        action: long("Moves uphill and braces", 1_400),
        dependencyOnOthers: long("Needs the cutter to wait", 1_400),
      },
    ],
    coopDependencyEvidence: long("Both players alter the balance", 1_900),
    socialTension: long("The cutter acts too early", 1_400),
    failureBeat: long("The platform tilts and loose bodies slide", 1_400),
    expectedViewerUnderstanding: long("Cutting shifts the shared platform", 1_900),
    cameraIntent: long("Third-person follow behind one controllable player", 1_400),
    requiredVisualEvidence: Array.from({ length: 20 }, (_, index) => long(`Moment evidence ${index}`, 230)),
    metadata: {},
  };
}

function shot(): ShotSpecV1 {
  return {
    schema: "gameplay_shot",
    version: 1,
    shotId: "tilt-salvage-test-shot",
    momentId: "tilt-salvage-test-moment",
    order: 0,
    durationSec: 5,
    purpose: "failure",
    actors: ["Cutter", "Counter-Weight", "engine block"],
    action: long("The player holds the cutting tool on the final bolt and the platform reacts", 1_900),
    camera: long("Third-person follow camera physically attached behind the controllable player", 1_400),
    environment: long("Small suspended industrial platform", 1_400),
    continuity: { preserve: [] },
    expectedEvidence: Array.from({ length: 20 }, (_, index) => long(`Shot evidence ${index}`, 230)),
    generationPlan: {
      keyframeRequired: true,
      imageModel: "nano-banana-2",
      videoModel: "kling-3",
      videoMode: "image-to-video",
      aspectRatio: "16:9",
      durationSec: 5,
    },
    metadata: {
      gameplayAuthenticityPlan: {
        schema: "gameplay_authenticity_plan",
        version: 1,
        shotId: "tilt-salvage-test-shot",
        momentId: "tilt-salvage-test-moment",
        controllablePlayer: {
          role: "Cutter",
          obvious: true,
          viewpointPlausiblyPlayable: true,
          scriptedCharactersOnly: false,
        },
        camera: {
          type: "third_person_follow",
          physicallyAttached: true,
          gameplayCameraJustified: true,
          visibleEvidence: long("Camera follows the Cutter at playable distance", 1_900),
        },
        playerInput: {
          input: long("Hold the cutting trigger", 1_400),
          visibleEvidence: long("Held tool emits sparks exactly while input is held", 1_900),
          visible: true,
        },
        playerAction: {
          action: long("Cut the final retaining bolt", 1_900),
          target: long("Final bolt on the engine mount", 1_900),
        },
        worldResponse: {
          response: long("Bolt separates, engine releases, platform rotates and loose entities slide", 1_900),
          causalResponseVisible: true,
        },
        gameplayAffordances: [
          {
            type: "held_tool",
            visible: true,
            meaningful: true,
            informationUsedByPlayer: long("Tool contact and sparks show active cutting", 1_900),
          },
          {
            type: "angle_meter",
            visible: true,
            meaningful: true,
            informationUsedByPlayer: long("Angle meter communicates balance state", 1_900),
          },
        ],
        coop: {
          dependencyVisible: true,
          teammateFunction: long("Counter-Weight braces on the opposite side", 1_900),
          visualEvidence: long("Teammate position directly opposes the released mass", 1_900),
        },
        physics: {
          event: long("Removing the engine shifts center of mass and rotates the platform", 1_900),
          consistent: true,
          affectedEntities: ["Cutter", "Counter-Weight", "engine block", "loose tools"],
          exceptions: [],
        },
        readability: {
          primaryActionReadable: true,
          visibleGoal: true,
          riskExpected: true,
          visibleRisk: true,
          visualClutter: "low",
        },
      },
    },
  };
}

function references(): Stage4GameplayReferenceSet {
  const purposes = ["gameplay_camera", "interaction", "coop", "art_direction"] as const;
  return {
    schema: "stage4_gameplay_reference_set",
    version: 1,
    references: purposes.map((purpose, index) => ({
      referenceId: `gref-${index}`,
      purpose,
      gameId: `game-${index}`,
      gameName: long(`Reference Game ${index}`, 200),
      driveFileId: `drive-${index}`,
      score: 0.9,
      whySelected: Array.from({ length: 12 }, (_, reason) => long(`Reason ${reason}`, 220)),
      gameplayDescription: long(`Detailed gameplay description ${index}`, 3_900),
      whyThisLooksLikeGameplay: long(`Gameplay grammar explanation ${index}`, 1_900),
    })),
  };
}

describe("gameplay prompt budget", () => {
  it("keeps rich typed gameplay/reference context inside the provider schema budget", () => {
    const plan = compileGameplayPromptPlan({
      concept: concept(),
      moment: moment(),
      shot: shot(),
      gameplayReferences: references(),
      feedbackMemory: {
        mustShow: Array.from({ length: 20 }, (_, index) => long(`Human must show ${index}`, 220)),
        mustAvoid: ["cinematic camera", "detached spectator camera", "decorative HUD"],
        errorTags: ["gameplay_authenticity_failure", "wrong_camera", "too_cinematic"],
      },
    });

    expect(plan.imagePrompt?.length).toBeLessThanOrEqual(8_000);
    expect(plan.videoPrompt.length).toBeLessThanOrEqual(8_000);
    expect(plan.imagePrompt).toContain("Reference A — GAMEPLAY_CAMERA");
    expect(plan.imagePrompt).toContain("Reference D — ART_DIRECTION");
    expect(plan.imagePrompt).toContain("REFERENCE FIREWALL");
    expect(plan.videoPrompt).toContain(
      "camera remains physically attached to the playable character for the entire clip",
    );
    expect(plan.metadata?.prompt_budget).toMatchObject({ schema_max_chars: 8_000 });
  });
});
