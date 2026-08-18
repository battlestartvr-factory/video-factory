import { describe, expect, it } from "vitest";
import { getDiscoveryLlmPolicy } from "../../lib/game-discovery/model-policy";
import { compileGameplayPromptPlan } from "../../lib/game-discovery/prompt-compiler";
import { planGameplayShots } from "../../lib/game-discovery/shot-planner";
import type {
  CoopGameConceptSpecV1,
  DiscoveryObjectiveSpecV1,
  GameplayMomentSpecV1,
} from "../../lib/game-discovery/schemas";

const objective: DiscoveryObjectiveSpecV1 = {
  schema: "discovery_objective",
  version: 1,
  objectiveId: "objective-visual",
  title: "Readable dependency",
  searchIntent: "Find co-op mechanics readable in a short gameplay reference.",
  playerCount: { min: 2, max: 4 },
  platform: "pc_steam",
  desiredNovelty: "balanced",
  conceptCount: 2,
  maxConceptsToPrototype: 1,
  constraints: {},
};

const concept: CoopGameConceptSpecV1 = {
  schema: "coop_game_concept",
  version: 1,
  conceptId: "split-crane",
  oneSentencePitch: "Two operators move one unstable crane load from different control stations.",
  coreMechanic: "One player controls horizontal crane travel while the other controls cable tension.",
  coopDependency: "Neither player can move and stabilize the load alone.",
  playerRoles: [
    { role: "Driver", responsibility: "Move the crane trolley." },
    { role: "Rigger", responsibility: "Control cable tension." },
  ],
  playerCount: { min: 2, max: 2, ideal: 2 },
  interactionModel: ["simultaneous asymmetric controls"],
  failureMode: "The suspended cargo swings into fragile machinery.",
  socialMoment: "The rigger warns the driver to stop before the cargo collides.",
  gameplayHook: "Shared control of one dangerous physical object.",
  spectacle: "A huge suspended load narrowly misses machinery.",
  setting: "Compact industrial repair bay.",
  artDirection: "Readable stylized industrial game art.",
  camera: "Third-person elevated gameplay camera showing both stations and the load.",
  readability: "Both players, the cable, cargo and collision target remain visible.",
  noveltyAxes: [
    { axis: "dependency_type", choice: "split-control", whyDifferent: "One object has divided controls." },
    { axis: "social_tension", choice: "trust-stop", whyDifferent: "One player must trust the other's stop call." },
  ],
  buildability: {
    networking: "low",
    physics: "medium",
    contentBurden: "low",
    npcAiDependency: "none",
    systemicInteractions: "medium",
    mainRisks: ["cargo readability"],
    mvpRead: "One room, one crane and two stations are sufficient.",
  },
  referenceInfluences: [],
};

const moment: GameplayMomentSpecV1 = {
  schema: "gameplay_moment",
  version: 1,
  momentId: "split-crane-swing",
  conceptId: "split-crane",
  hypothesis: "Viewers understand the divided controls when the load starts swinging toward machinery.",
  durationTargetSec: 5,
  setup: "Cargo is already suspended between the two control stations.",
  playerActions: [
    { role: "Driver", action: "Moves the trolley right.", dependencyOnOthers: "Needs the Rigger to damp the swing." },
    { role: "Rigger", action: "Tightens the cable.", dependencyOnOthers: "Needs the Driver to stop lateral movement." },
  ],
  coopDependencyEvidence: "The cargo stabilizes only when movement and tension changes are coordinated.",
  socialTension: "Rigger urgently calls stop while the Driver is still moving.",
  failureBeat: "Cargo clips a fragile machine if coordination is late.",
  expectedViewerUnderstanding: "Two people control different dimensions of one dangerous object.",
  cameraIntent: "Keep both players, cargo and target visible in one gameplay frame.",
  requiredVisualEvidence: [
    "both control stations visible",
    "cargo visibly swinging toward fragile machinery",
    "cable tension visibly changing",
  ],
};

function validShotResponse() {
  return JSON.stringify({
    shots: [
      {
        schema: "gameplay_shot",
        version: 1,
        shotId: "split-crane-swing-shot-0",
        momentId: "split-crane-swing",
        order: 0,
        durationSec: 5,
        purpose: "mechanic",
        actors: ["Driver", "Rigger"],
        action: "Driver moves right as Rigger tightens the cable while the cargo swings toward the machine.",
        camera: "Elevated third-person gameplay camera with both stations and cargo visible.",
        environment: "Compact industrial repair bay with one fragile machine beside the cargo path.",
        continuity: { preserve: [] },
        expectedEvidence: [
          "both control stations visible",
          "cargo visibly swinging toward fragile machinery",
          "cable tension visibly changing",
        ],
        generationPlan: {
          keyframeRequired: true,
          imageModel: "nano-banana-2",
          videoModel: "kling-3",
          videoMode: "image-to-video",
          aspectRatio: "9:16",
          durationSec: 5,
        },
      },
    ],
  });
}

describe("Stage 4 token economy and visual approval planning", () => {
  it("routes simple tasks to cheap models and blocks automatic top-tier use", () => {
    expect(getDiscoveryLlmPolicy("concept_pre_evaluation").primaryModel).toBe("claude-haiku-4-5");
    expect(getDiscoveryLlmPolicy("schema_repair").primaryModel).toBe("claude-haiku-4-5");
    expect(getDiscoveryLlmPolicy("feedback_structuring").primaryModel).toBe("claude-haiku-4-5");
    expect(getDiscoveryLlmPolicy("concept_exploration").primaryModel).toBe("claude-sonnet-5");
    expect(getDiscoveryLlmPolicy("shot_planning")).toMatchObject({
      primaryModel: "claude-haiku-4-5",
      fallbackModels: ["claude-sonnet-5"],
      automaticEscalation: true,
    });
  });

  it("uses Haiku for a valid first shot and keeps required evidence auditable", async () => {
    const calls: Array<{ model: string; thinking?: boolean | null }> = [];
    const result = await planGameplayShots({
      llm: {
        generate: async (request) => {
          calls.push({ model: request.model, thinking: request.thinking });
          return {
            text: validShotResponse(),
            usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180 },
            stopReason: "end_turn",
            responsePayload: {},
          };
        },
      },
      objective,
      concepts: [concept],
      moments: [moment],
      feedbackMemory: {
        mustShow: ["players must look like they are operating controls, not posing"],
        mustAvoid: ["wide cinematic establishing shot"],
        errorTags: ["too_cinematic"],
      },
    });

    expect(calls).toEqual([{ model: "claude-haiku-4-5", thinking: false }]);
    expect(result.escalated).toBe(false);
    expect(result.shots[0]?.expectedEvidence).toEqual(moment.requiredVisualEvidence);
  });

  it("compiles approval-first image/video prompts without another LLM call", () => {
    const shot = JSON.parse(validShotResponse()).shots[0];
    const plan = compileGameplayPromptPlan({
      concept,
      moment,
      shot,
      feedbackMemory: {
        mustShow: ["players must look like they are operating controls, not posing"],
        mustAvoid: ["wide cinematic establishing shot"],
        errorTags: ["too_cinematic"],
      },
    });

    expect(plan.imagePrompt).toContain("approval checkpoint before any video generation");
    expect(plan.imagePrompt).toContain("players must look like they are operating controls, not posing");
    expect(plan.negativeConstraints).toContain("wide cinematic establishing shot");
    expect(plan.metadata).toMatchObject({
      reference_approval_required: true,
      human_feedback_applied: true,
    });
    expect(plan.compilerInputsHash.length).toBeGreaterThanOrEqual(16);
  });
});
