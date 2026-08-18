import { describe, expect, it } from "vitest";
import {
  assetGraphV1Schema,
  conceptPreEvaluationV1Schema,
  coopGameConceptSpecV1Schema,
  discoveryObjectiveSpecV1Schema,
  gameplayMomentSpecV1Schema,
  promptPlanV1Schema,
  shotSpecV1Schema,
} from "../../lib/game-discovery";

const concept = {
  schema: "coop_game_concept" as const,
  version: 1 as const,
  conceptId: "concept-1",
  oneSentencePitch: "Two couriers carry one unstable machine through a collapsing facility.",
  coreMechanic: "Both players manipulate different controls on the same physical machine while moving.",
  coopDependency: "Neither player has enough controls to stabilize and navigate the machine alone.",
  playerRoles: [
    { role: "pilot", responsibility: "Chooses movement and route." },
    { role: "stabilizer", responsibility: "Counters momentum and protects fragile cargo." },
  ],
  playerCount: { min: 2, max: 4, ideal: 2 },
  interactionModel: ["shared_object", "physics_coordination"],
  failureMode: "A mistimed correction throws the machine into walls and cascades into a rescue scramble.",
  socialMoment: "The pilot blames the stabilizer while both desperately recover the same machine.",
  gameplayHook: "Two players visibly fight one wobbling machine with different controls.",
  spectacle: "A heavy machine swings, sparks and drags both players through the environment.",
  setting: "Compact industrial test facility.",
  artDirection: "Readable stylized 3D with strong interactable silhouettes.",
  camera: "Close third-person camera framing both players and the shared machine.",
  readability: "The machine, both player roles and the consequence of bad coordination stay visible together.",
  noveltyAxes: [
    { axis: "dependency", choice: "shared_object", whyDifferent: "Both players operate one unstable object." },
    { axis: "failure_signature", choice: "cascading_disaster", whyDifferent: "Small corrections compound into physical chaos." },
  ],
  buildability: {
    networking: "medium" as const,
    physics: "medium" as const,
    contentBurden: "low" as const,
    npcAiDependency: "none" as const,
    systemicInteractions: "medium" as const,
    mainRisks: ["networked physics"],
    mvpRead: "One room, one machine and one obstacle course can test the core dependency.",
  },
  referenceInfluences: [],
};

describe("Stage 4 game discovery schemas", () => {
  it("accepts a bounded PC/Steam discovery objective", () => {
    const parsed = discoveryObjectiveSpecV1Schema.parse({
      schema: "discovery_objective",
      version: 1,
      objectiveId: "objective-1",
      title: "Explore physical co-op dependencies",
      searchIntent: "Find visually readable 2–4 player mechanics with fast social failure.",
      playerCount: { min: 2, max: 4 },
      platform: "pc_steam",
      desiredNovelty: "explore",
      conceptCount: 6,
      maxConceptsToPrototype: 2,
      constraints: { networkingComplexity: "medium", npcAiDependency: "avoid" },
      metadata: { requestedFrom: "unit-test" },
    });

    expect(parsed.conceptCount).toBe(6);
    expect(parsed.maxConceptsToPrototype).toBe(2);
    expect(parsed.metadata).toEqual({ requestedFrom: "unit-test" });
  });

  it("rejects objectives that prototype more concepts than they generate", () => {
    const result = discoveryObjectiveSpecV1Schema.safeParse({
      schema: "discovery_objective",
      version: 1,
      objectiveId: "objective-1",
      title: "Bad budget",
      searchIntent: "Invalid budget relationship.",
      playerCount: { min: 2, max: 4 },
      platform: "pc_steam",
      desiredNovelty: "balanced",
      conceptCount: 2,
      maxConceptsToPrototype: 3,
      constraints: {},
    });

    expect(result.success).toBe(false);
  });

  it("accepts a structured co-op concept and rejects invalid player-count ranges", () => {
    expect(coopGameConceptSpecV1Schema.parse(concept).conceptId).toBe("concept-1");

    const result = coopGameConceptSpecV1Schema.safeParse({
      ...concept,
      playerCount: { min: 4, max: 2, ideal: 3 },
    });
    expect(result.success).toBe(false);
  });

  it("requires gameplay moments to expose an outcome beat", () => {
    const base = {
      schema: "gameplay_moment" as const,
      version: 1 as const,
      momentId: "moment-1",
      conceptId: "concept-1",
      hypothesis: "The shared-object failure will create immediately readable social tension.",
      durationTargetSec: 5,
      setup: "The pair enters a narrow turn while carrying the unstable machine.",
      playerActions: [
        { role: "pilot", action: "Turns left", dependencyOnOthers: "Needs simultaneous counterbalance." },
        { role: "stabilizer", action: "Counterbalances", dependencyOnOthers: "Needs the pilot to hold a predictable route." },
      ],
      coopDependencyEvidence: "The machine visibly tilts unless both inputs arrive together.",
      socialTension: "Panic and blame during recovery.",
      expectedViewerUnderstanding: "Two people must coordinate one object or both fail.",
      cameraIntent: "Keep both players and the machine in frame.",
      requiredVisualEvidence: ["both players", "shared machine", "visible tilt"],
    };

    expect(
      gameplayMomentSpecV1Schema.parse({ ...base, failureBeat: "The machine slams into the wall." }).failureBeat,
    ).toBeTruthy();
    expect(gameplayMomentSpecV1Schema.safeParse(base).success).toBe(false);
  });

  it("ties keyframe shots to image-to-video generation", () => {
    const shot = {
      schema: "gameplay_shot" as const,
      version: 1 as const,
      shotId: "shot-1",
      momentId: "moment-1",
      order: 0,
      durationSec: 5,
      purpose: "mechanic" as const,
      actors: ["pilot", "stabilizer"],
      action: "Both players try to carry and stabilize the same machine through a corner.",
      camera: "Close third-person two-player framing.",
      environment: "Industrial corridor.",
      continuity: { preserve: ["machine shape", "player colors"] },
      expectedEvidence: ["visible shared object", "different role actions"],
      generationPlan: {
        keyframeRequired: true,
        imageModel: "gpt-image-2" as const,
        videoModel: "kling-3",
        videoMode: "image-to-video" as const,
        aspectRatio: "9:16" as const,
        durationSec: 5,
      },
    };

    expect(shotSpecV1Schema.parse(shot).generationPlan.videoMode).toBe("image-to-video");
    expect(
      shotSpecV1Schema.safeParse({
        ...shot,
        generationPlan: { ...shot.generationPlan, imageModel: undefined, videoMode: "text-to-video" },
      }).success,
    ).toBe(false);
  });

  it("validates prompt plans and asset-graph references", () => {
    expect(
      promptPlanV1Schema.parse({
        schema: "prompt_plan",
        version: 1,
        conceptId: "concept-1",
        momentId: "moment-1",
        shotId: "shot-1",
        imagePrompt: "Readable fake gameplay keyframe with both players and the shared machine.",
        videoPrompt: "Animate the same shared machine wobbling while both players coordinate.",
        negativeConstraints: ["no cinematic cutaway"],
        compilerInputsHash: "0123456789abcdef",
        providerModel: "kling-3",
      }).providerModel,
    ).toBe("kling-3");

    const validGraph = {
      schema: "asset_graph" as const,
      version: 1 as const,
      objectiveRunId: "run-objective",
      conceptRunId: "run-concept",
      nodes: [
        { id: "concept", kind: "concept" as const, creativeRunId: "run-concept" },
        { id: "shot", kind: "shot" as const },
        { id: "video", kind: "video" as const, generationId: "generation-1" },
      ],
      edges: [
        { from: "concept", to: "shot", relation: "plans" as const },
        { from: "shot", to: "video", relation: "animates" as const },
      ],
    };

    expect(assetGraphV1Schema.parse(validGraph).nodes).toHaveLength(3);
    expect(
      assetGraphV1Schema.safeParse({
        ...validGraph,
        edges: [{ from: "missing", to: "video", relation: "animates" }],
      }).success,
    ).toBe(false);
  });

  it("requires explicit reasons when the cheap concept pre-evaluator fails", () => {
    expect(
      conceptPreEvaluationV1Schema.safeParse({
        schema: "concept_pre_evaluation",
        version: 1,
        conceptId: "concept-1",
        coOpDependency: "fail",
        instantReadability: "pass",
        buildability: "pass",
        rejectionReasons: [],
        cautionFlags: [],
      }).success,
    ).toBe(false);

    expect(
      conceptPreEvaluationV1Schema.parse({
        schema: "concept_pre_evaluation",
        version: 1,
        conceptId: "concept-1",
        coOpDependency: "fail",
        instantReadability: "pass",
        buildability: "pass",
        rejectionReasons: ["The second player is optional rather than mechanically necessary."],
        cautionFlags: [],
      }).rejectionReasons,
    ).toHaveLength(1);
  });

  it("rejects unknown top-level domain fields while allowing explicit metadata", () => {
    expect(coopGameConceptSpecV1Schema.safeParse({ ...concept, surpriseField: true }).success).toBe(false);
    expect(
      coopGameConceptSpecV1Schema.parse({ ...concept, metadata: { futureHint: "allowed" } }).metadata,
    ).toEqual({ futureHint: "allowed" });
  });
});
