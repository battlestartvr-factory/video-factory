import { describe, expect, it } from "vitest";
import { compileGameplayPromptPlan } from "@/lib/game-discovery/prompt-compiler";
import { gameplayDurationSeconds } from "@/lib/game-discovery/moment-planner";
import { PRIMARY_GAMEPLAY_VIDEO_MODEL } from "@/lib/game-discovery/shot-planner";
import type {
  CoopGameConceptSpecV1,
  DiscoveryObjectiveSpecV1,
  GameplayMomentSpecV1,
  ShotSpecV1,
} from "@/lib/game-discovery/schemas";

function concept(): CoopGameConceptSpecV1 {
  return {
    schema: "coop_game_concept",
    version: 1,
    conceptId: "shared-winch",
    oneSentencePitch: "Two players keep a suspended load balanced while operating one shared winch.",
    coreMechanic: "One player drives the winch while the other physically counterbalances and guides the load.",
    coopDependency: "The winch operator cannot see or correct the far-side balance without the teammate acting on it.",
    playerRoles: [
      { role: "Winch Operator", responsibility: "Controls tension and direction." },
      { role: "Balancer", responsibility: "Moves and braces to keep the load stable." },
    ],
    playerCount: { min: 2, max: 2, ideal: 2 },
    interactionModel: ["shared_object", "physics_coordination"],
    failureMode: "A mistimed pull tips the platform and makes the load swing into the level.",
    socialMoment: "The balancer shouts for the operator to stop before the load swings too far.",
    gameplayHook: "A shared suspended load visibly reacts to both players at once.",
    spectacle: "The load swings and the platform tilts in a readable physical chain reaction.",
    setting: "Compact industrial salvage platform.",
    artDirection: "Readable stylized indie industrial game art.",
    camera: "Third-person follow camera behind the winch operator.",
    readability: "Keep the winch, load, teammate and immediate consequence in the playable frame.",
    noveltyAxes: [
      { axis: "dependency", choice: "shared tension", whyDifferent: "Both players continuously alter one physical system." },
      { axis: "failure", choice: "recoverable swing", whyDifferent: "A mistake creates a visible recovery problem instead of a reset." },
    ],
    buildability: {
      networking: "medium",
      physics: "medium",
      contentBurden: "low",
      npcAiDependency: "none",
      systemicInteractions: "medium",
      mainRisks: ["networked load physics"],
      mvpRead: "One room, one winch, one suspended load and two player roles are enough for the prototype.",
    },
    referenceInfluences: [],
    metadata: {},
  };
}

function moment(): GameplayMomentSpecV1 {
  return {
    schema: "gameplay_moment",
    version: 1,
    momentId: "shared-winch-moment",
    conceptId: "shared-winch",
    hypothesis: "A viewer understands the co-op dependency when one player's pull visibly forces the other player to rebalance.",
    durationTargetSec: 10,
    setup: "Both players stand around the same suspended load and winch on a compact platform.",
    playerActions: [
      { role: "Winch Operator", action: "holds the winch input", dependencyOnOthers: "needs the Balancer to counter the swing" },
      { role: "Balancer", action: "moves uphill and braces", dependencyOnOthers: "needs the operator to stop before over-tension" },
    ],
    coopDependencyEvidence: "The teammate's position changes whether the shared load remains controllable.",
    socialTension: "The operator keeps pulling a fraction too long while the teammate scrambles to recover.",
    failureBeat: "The load swings, the platform tips, and the teammate visibly fights the new balance.",
    expectedViewerUnderstanding: "The player caused a physical response that immediately created work for the teammate.",
    cameraIntent: "Normal third-person follow camera attached behind the controllable winch operator.",
    requiredVisualEvidence: ["shared winch", "suspended load", "visible teammate counterbalance", "load swings after input"],
    metadata: {},
  };
}

function shot(): ShotSpecV1 {
  return {
    schema: "gameplay_shot",
    version: 1,
    shotId: "shared-winch-shot",
    momentId: "shared-winch-moment",
    order: 0,
    durationSec: 10,
    purpose: "mechanic",
    actors: ["Winch Operator", "Balancer", "suspended load"],
    action: "The controllable player holds the winch input, the load starts swinging, and the teammate visibly counterbalances.",
    camera: "Third-person follow camera physically attached behind the Winch Operator at normal gameplay distance.",
    environment: "Compact industrial salvage platform with the shared winch and suspended load in view.",
    continuity: { preserve: [] },
    expectedEvidence: ["shared winch", "suspended load", "visible teammate counterbalance", "load swings after input"],
    generationPlan: {
      keyframeRequired: true,
      imageModel: "gpt-image-2",
      videoModel: "minimax-h3",
      videoMode: "image-to-video",
      aspectRatio: "16:9",
      durationSec: 10,
    },
    metadata: {
      gameplayAuthenticityPlan: {
        schema: "gameplay_authenticity_plan",
        version: 1,
        shotId: "shared-winch-shot",
        momentId: "shared-winch-moment",
        controllablePlayer: {
          role: "Winch Operator",
          obvious: true,
          viewpointPlausiblyPlayable: true,
          scriptedCharactersOnly: false,
        },
        camera: {
          type: "third_person_follow",
          physicallyAttached: true,
          gameplayCameraJustified: true,
          visibleEvidence: "The camera stays directly behind the Winch Operator at normal control distance.",
        },
        playerInput: {
          input: "hold the winch trigger",
          visibleEvidence: "the winch drum turns while the held interaction remains active",
          visible: true,
        },
        playerAction: {
          action: "pull the shared suspended load with the winch",
          target: "the suspended load",
        },
        worldResponse: {
          response: "the cable tightens, the load swings, and the platform begins to tilt toward the moving mass",
          causalResponseVisible: true,
        },
        gameplayAffordances: [
          {
            type: "held_tool",
            visible: true,
            meaningful: true,
            informationUsedByPlayer: "the active winch handle and cable tension show the current player action",
          },
        ],
        coop: {
          dependencyVisible: true,
          teammateFunction: "the Balancer moves uphill and braces against the opposite side",
          visualEvidence: "the teammate's movement visibly counters the same tilt caused by the load",
        },
        physics: {
          event: "winch tension moves the suspended mass and shifts the platform balance",
          consistent: true,
          affectedEntities: ["suspended load", "platform", "Winch Operator", "Balancer"],
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

describe("MiniMax H3 gameplay defaults and prompt compiler", () => {
  it("defaults Stage 4 gameplay experiments to 10 seconds and H3", () => {
    const objective = {
      schema: "discovery_objective",
      version: 1,
      metadata: {},
    } as DiscoveryObjectiveSpecV1;

    expect(gameplayDurationSeconds(objective)).toBe(10);
    expect(PRIMARY_GAMEPLAY_VIDEO_MODEL).toBe("minimax-h3");
  });

  it("compiles a bounded H3 prompt with frame lock, ordered gameplay timing and player-bound camera", () => {
    const plan = compileGameplayPromptPlan({
      concept: concept(),
      moment: moment(),
      shot: shot(),
      feedbackMemory: {
        mustShow: ["the teammate visibly reacts to the load swing"],
        mustAvoid: ["cinematic camera"],
        errorTags: ["detached_camera"],
      },
    });

    expect(plan.providerModel).toBe("minimax-h3");
    expect(plan.videoPrompt.length).toBeLessThanOrEqual(4_800);
    expect(plan.videoPrompt).toContain("AUTHENTIC PC CO-OP GAMEPLAY — IMAGE TO VIDEO");
    expect(plan.videoPrompt).toContain("FRAME-0 CONTINUITY LOCK");
    expect(plan.videoPrompt).toContain("0.0–2.0 sec");
    expect(plan.videoPrompt).toContain("2.0–5.0 sec");
    expect(plan.videoPrompt).toContain("5.0–7.0 sec");
    expect(plan.videoPrompt).toContain("7.0–10.0 sec");
    expect(plan.videoPrompt).toContain("camera remains physically attached to the playable character for the entire clip");
    expect(plan.videoPrompt).toContain("No cuts, montage, cinematic reframing");
    expect(plan.metadata?.video_prompt_profile).toBe("minimax_h3_gameplay_i2v_v1");
    expect(plan.metadata?.prompt_budget).toMatchObject({
      provider_max_chars: 4_800,
      video_prompt_chars: plan.videoPrompt.length,
    });
  });
});
