import { describe, expect, it } from "vitest";
import {
  conceptPreEvaluationV1Schema,
  coopGameConceptSpecV1Schema,
  discoveryObjectiveSpecV1Schema,
  gameplayMomentSpecV1Schema,
  promptPlanV1Schema,
  shotSpecV1Schema,
} from "../../lib/game-discovery/schemas";
import {
  assessConceptDiversity,
  compareConceptDiversity,
  conceptDiversitySignature,
} from "../../lib/game-discovery/diversity";
import { evaluateConcepts } from "../../lib/game-discovery/pre-evaluator";

const objectiveFixture = {
  schema: "discovery_objective" as const,
  version: 1 as const,
  objectiveId: "objective-001",
  title: "Find a compact friends co-op concept",
  searchIntent: "Explore 2–4 player co-op mechanics that are readable in a short gameplay clip.",
  playerCount: { min: 2 as const, max: 4 as const },
  platform: "pc_steam" as const,
  desiredNovelty: "explore" as const,
  conceptCount: 6,
  maxConceptsToPrototype: 2,
  constraints: {
    maxMvpMonths: 8,
    networkingComplexity: "medium" as const,
    contentBurden: "low" as const,
    npcAiDependency: "avoid" as const,
  },
  searchSpace: {
    dependencyTypes: ["asymmetric tools", "shared physics"],
    socialTensions: ["panic", "trust"],
  },
  metadata: { fixture: true },
};

const conceptFixture = {
  schema: "coop_game_concept" as const,
  version: 1 as const,
  conceptId: "concept-001",
  oneSentencePitch:
    "Two to four salvage climbers move one unstable reactor core through a collapsing orbital shaft.",
  coreMechanic:
    "Players carry a shared physics object whose heat, momentum, and orientation are controlled by different handles.",
  coopDependency:
    "No player can stabilize all axes alone; teammates must call direction changes and trade dangerous positions.",
  playerRoles: [
    {
      role: "Front carrier",
      responsibility: "Steers horizontal movement and calls upcoming obstacles.",
      information: "Sees the route before the rear carrier.",
    },
    {
      role: "Rear carrier",
      responsibility: "Controls tilt and prevents the core from striking geometry.",
      power: "Can dump heat at the cost of losing grip strength.",
    },
  ],
  playerCount: { min: 2, max: 4, ideal: 3 },
  interactionModel: ["shared object", "asymmetric information", "position swapping"],
  failureMode:
    "The core clips the environment, spikes in heat, and blasts the nearest player backward while everyone scrambles to recover it.",
  socialMoment:
    "One carrier insists the route is clear, the blind teammate commits, and the whole group starts yelling when the core begins to roll.",
  gameplayHook: "Carry one dangerous object together while nobody has complete control.",
  spectacle: "A glowing reactor core swings over a deep orbital shaft as players barely hold it.",
  setting: "A damaged orbital salvage station with short industrial traversal rooms.",
  artDirection: "Readable chunky industrial sci-fi with bright player colors and simple hazard silhouettes.",
  camera: "Third-person medium-wide camera that keeps the core and all attached players visible.",
  readability: "The core is the visual anchor; handle colors expose who controls each axis.",
  noveltyAxes: [
    {
      axis: "dependency_type",
      choice: "shared multi-axis object",
      whyDifferent: "The same object distributes control across players rather than giving them parallel tasks.",
    },
    {
      axis: "social_tension",
      choice: "blind commitment",
      whyDifferent: "The player with movement authority cannot see all consequences.",
    },
    {
      axis: "tempo",
      choice: "slow tension into sudden recovery",
      whyDifferent: "Failure creates a fast cooperative scramble after deliberate carrying.",
    },
    {
      axis: "camera_scale",
      choice: "medium wide shared-object framing",
      whyDifferent: "Every required player and the dependency object stay in one readable frame.",
    },
    {
      axis: "failure_signature",
      choice: "object destabilization cascade",
      whyDifferent: "Failure changes the shared object's state before directly defeating players.",
    },
    {
      axis: "buildability_shape",
      choice: "one systemic object plus modular rooms",
      whyDifferent: "Depth comes from one reusable system instead of large content volume.",
    },
  ],
  buildability: {
    networking: "medium" as const,
    physics: "medium" as const,
    contentBurden: "low" as const,
    npcAiDependency: "none" as const,
    systemicInteractions: "medium" as const,
    mainRisks: ["networked shared-object feel", "camera collision in narrow rooms"],
    mvpRead: "Prototype one shaft room, one core, two handle roles, and one destabilization failure loop.",
  },
  referenceInfluences: [
    {
      reference: "co-op shared-object games",
      borrowedPrinciple: "Players coordinate around one legible shared responsibility.",
      mustNotCopy: "Do not copy a known game's objects, levels, characters, or exact control scheme.",
    },
  ],
  metadata: { fixture: true },
};

function conceptVariant(input: {
  conceptId: string;
  coreMechanic?: string;
  dependency?: string;
  social?: string;
  tempo?: string;
  camera?: string;
  failure?: string;
  buildability?: string;
}) {
  const value = structuredClone(conceptFixture);
  value.conceptId = input.conceptId;
  if (input.coreMechanic) value.coreMechanic = input.coreMechanic;
  const choices: Record<string, string | undefined> = {
    dependency_type: input.dependency,
    social_tension: input.social,
    tempo: input.tempo,
    camera_scale: input.camera,
    failure_signature: input.failure,
    buildability_shape: input.buildability,
  };
  value.noveltyAxes = value.noveltyAxes.map((axis) => ({
    ...axis,
    choice: choices[axis.axis] ?? axis.choice,
  }));
  return value;
}

describe("Stage 4 game discovery schemas", () => {
  it("accepts a valid discovery objective", () => {
    const parsed = discoveryObjectiveSpecV1Schema.parse(objectiveFixture);
    expect(parsed.conceptCount).toBe(6);
    expect(parsed.platform).toBe("pc_steam");
  });

  it("rejects a prototype budget larger than the concept batch", () => {
    expect(() =>
      discoveryObjectiveSpecV1Schema.parse({
        ...objectiveFixture,
        conceptCount: 2,
        maxConceptsToPrototype: 3,
      }),
    ).toThrow();
  });

  it("accepts a constitution-aligned co-op concept", () => {
    const parsed = coopGameConceptSpecV1Schema.parse(conceptFixture);
    expect(parsed.playerCount.ideal).toBe(3);
    expect(parsed.noveltyAxes.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects an invalid ideal player count", () => {
    expect(() =>
      coopGameConceptSpecV1Schema.parse({
        ...conceptFixture,
        playerCount: { min: 2, max: 3, ideal: 4 },
      }),
    ).toThrow();
  });

  it("requires gameplay evidence to include success or failure", () => {
    expect(() =>
      gameplayMomentSpecV1Schema.parse({
        schema: "gameplay_moment",
        version: 1,
        momentId: "moment-1",
        conceptId: conceptFixture.conceptId,
        hypothesis: "Players understand why the shared object requires both of them.",
        durationTargetSec: 5,
        setup: "Two players carry the reactor core toward a narrow doorway.",
        playerActions: [
          { role: "Front carrier", action: "Turns left", dependencyOnOthers: "Needs rear tilt control" },
          { role: "Rear carrier", action: "Raises handle", dependencyOnOthers: "Needs front route call" },
        ],
        coopDependencyEvidence: "The object visibly rolls unless both inputs align.",
        socialTension: "The rear player commits to a move they cannot fully see.",
        expectedViewerUnderstanding: "Each player controls a different part of the same object.",
        cameraIntent: "Keep both players and core in frame.",
        requiredVisualEvidence: ["two colored handles", "core tilt", "narrow obstacle"],
      }),
    ).toThrow();
  });

  it("enforces keyframe/image-to-video invariants on shots", () => {
    expect(() =>
      shotSpecV1Schema.parse({
        schema: "gameplay_shot",
        version: 1,
        shotId: "shot-1",
        momentId: "moment-1",
        order: 0,
        durationSec: 5,
        purpose: "mechanic",
        actors: ["Front carrier", "Rear carrier", "reactor core"],
        action: "The players twist the core around a doorway.",
        camera: "Medium-wide third person.",
        environment: "Industrial shaft doorway.",
        continuity: { preserve: [] },
        expectedEvidence: ["shared core", "two simultaneous handles"],
        generationPlan: {
          keyframeRequired: true,
          videoModel: "kling-3",
          videoMode: "text-to-video",
          aspectRatio: "9:16",
          durationSec: 5,
        },
      }),
    ).toThrow();
  });

  it("requires prompt compiler lineage fields", () => {
    const parsed = promptPlanV1Schema.parse({
      schema: "prompt_plan",
      version: 1,
      conceptId: "concept-001",
      momentId: "moment-001",
      shotId: "shot-001",
      videoPrompt: "Show readable shared-object co-op gameplay.",
      negativeConstraints: ["no cinematic cutaway"],
      compilerInputsHash: "1234567890abcdef",
      providerModel: "kling-3",
    });
    expect(parsed.compilerInputsHash).toHaveLength(16);
  });

  it("requires reasons for failed pre-evaluations", () => {
    expect(() =>
      conceptPreEvaluationV1Schema.parse({
        schema: "concept_pre_evaluation",
        version: 1,
        conceptId: "concept-001",
        coOpDependency: "fail",
        instantReadability: "pass",
        buildability: "pass",
        rejectionReasons: [],
        cautionFlags: [],
      }),
    ).toThrow();
  });
});

describe("Stage 4 diversity guard", () => {
  it("derives the six explicit diversity axes", () => {
    const parsed = coopGameConceptSpecV1Schema.parse(conceptFixture);
    const signature = conceptDiversitySignature(parsed);
    expect(signature).toMatchObject({
      dependencyType: "shared multi axis object",
      socialTension: "blind commitment",
      tempo: "slow tension into sudden recovery",
      cameraScale: "medium wide shared object framing",
      failureSignature: "object destabilization cascade",
      buildabilityShape: "one systemic object plus modular rooms",
    });
  });

  it("rejects the same normalized core mechanic plus dependency type", () => {
    const first = coopGameConceptSpecV1Schema.parse(conceptFixture);
    const duplicate = coopGameConceptSpecV1Schema.parse(
      conceptVariant({ conceptId: "concept-duplicate", social: "status rivalry", camera: "top down" }),
    );
    const comparison = compareConceptDiversity(duplicate, first);
    expect(comparison.hardDuplicate).toBe(true);
    expect(comparison.reasons).toContain("same_core_mechanic_and_dependency");
  });

  it("accepts a concept that moves across several novelty axes", () => {
    const first = coopGameConceptSpecV1Schema.parse(conceptFixture);
    const distinct = coopGameConceptSpecV1Schema.parse(
      conceptVariant({
        conceptId: "concept-distinct",
        coreMechanic: "Players remotely route one another through separate rooms by swapping camera feeds and door authority.",
        dependency: "remote information relay",
        social: "miscommunication blame",
        tempo: "rapid callouts",
        camera: "split-room fixed cameras",
        failure: "wrong-player lockout",
        buildability: "low-physics room graph",
      }),
    );
    const assessment = assessConceptDiversity(distinct, [first]);
    expect(assessment.decision).toBe("accept");
    expect(assessment.nearest?.axisDistance).toBeGreaterThanOrEqual(2);
  });

  it("marks low-axis-distance concepts for replacement with explainable axes", () => {
    const first = coopGameConceptSpecV1Schema.parse(conceptFixture);
    const nearDuplicate = coopGameConceptSpecV1Schema.parse(
      conceptVariant({
        conceptId: "concept-near",
        coreMechanic: "Players carry a shared reactor using linked handles while keeping it from colliding with walls.",
        social: "shared embarrassment",
        camera: "slightly wider shared-object framing",
      }),
    );
    const assessment = assessConceptDiversity(nearDuplicate, [first]);
    expect(assessment.decision).toBe("replace");
    expect(assessment.rejectionReasons.length).toBeGreaterThan(0);
    expect(assessment.underexploredAxes.length).toBeGreaterThan(0);
  });
});

describe("Stage 4 concept pre-evaluator", () => {
  it("accepts a clean concept that passes the three explicit gates", async () => {
    const concept = coopGameConceptSpecV1Schema.parse(conceptFixture);
    const calls: string[] = [];
    const result = await evaluateConcepts({
      objective: discoveryObjectiveSpecV1Schema.parse(objectiveFixture),
      concepts: [concept],
      llm: {
        generate: async (request) => {
          calls.push(request.model);
          return {
            text: JSON.stringify({
              evaluations: [
                {
                  schema: "concept_pre_evaluation",
                  version: 1,
                  conceptId: concept.conceptId,
                  coOpDependency: "pass",
                  instantReadability: "pass",
                  buildability: "pass",
                  rejectionReasons: [],
                  cautionFlags: ["physics feel needs a prototype"],
                },
              ],
            }),
            usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
            stopReason: "stop",
            responsePayload: {},
          };
        },
      },
    });

    expect(calls).toEqual(["claude-haiku-4-5"]);
    expect(result.passingConceptIds).toEqual([concept.conceptId]);
    expect(result.rejectedConceptIds).toEqual([]);
  });

  it("deterministically rejects a concept that violates the objective buildability cap", async () => {
    const concept = coopGameConceptSpecV1Schema.parse({
      ...conceptFixture,
      conceptId: "concept-heavy-network",
      buildability: {
        ...conceptFixture.buildability,
        networking: "high",
      },
    });
    const result = await evaluateConcepts({
      objective: discoveryObjectiveSpecV1Schema.parse(objectiveFixture),
      concepts: [concept],
      llm: {
        generate: async () => ({
          text: JSON.stringify({
            evaluations: [
              {
                schema: "concept_pre_evaluation",
                version: 1,
                conceptId: concept.conceptId,
                coOpDependency: "pass",
                instantReadability: "pass",
                buildability: "pass",
                rejectionReasons: [],
                cautionFlags: [],
              },
            ],
          }),
          usage: {},
          stopReason: "stop",
          responsePayload: {},
        }),
      },
    });

    expect(result.passingConceptIds).toEqual([]);
    expect(result.rejectedConceptIds).toEqual([concept.conceptId]);
    expect(result.evaluations[0]).toMatchObject({ buildability: "fail" });
    expect(result.evaluations[0]?.rejectionReasons).toContain(
      "networking_complexity_exceeds_objective:medium",
    );
  });
});
