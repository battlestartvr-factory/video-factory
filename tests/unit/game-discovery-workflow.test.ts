import { describe, expect, it } from "vitest";
import type { WorkflowTickContext } from "../../worker/workflows/types";
import { gameDiscoveryBatchV1 } from "../../worker/workflows/game-discovery-batch-v1";

const objective = {
  schema: "discovery_objective" as const,
  version: 1 as const,
  objectiveId: "objective-1",
  title: "Explore asymmetric co-op dependencies",
  searchIntent: "Find readable 2–4 player PC co-op mechanics with strong social failure moments.",
  playerCount: { min: 2 as const, max: 4 as const },
  platform: "pc_steam" as const,
  desiredNovelty: "explore" as const,
  conceptCount: 6,
  maxConceptsToPrototype: 2,
  constraints: {},
};

const concept = {
  schema: "coop_game_concept" as const,
  version: 1 as const,
  conceptId: "concept-1",
  oneSentencePitch: "Two operators steer one unstable salvage machine through a collapsing station.",
  coreMechanic: "Each player controls a different coupled subsystem of the same moving machine.",
  coopDependency: "Motion and tool use require simultaneous inputs from both operators.",
  playerRoles: [
    { role: "driver", responsibility: "controls thrust" },
    { role: "operator", responsibility: "aims and stabilizes the salvage arm" },
  ],
  playerCount: { min: 2, max: 4, ideal: 2 },
  interactionModel: ["shared_system", "timing"],
  failureMode: "One mistimed input spins the machine into hazards.",
  socialMoment: "Players blame each other while recovering from a shared spin.",
  gameplayHook: "Two cursors visibly fight over one unstable machine.",
  spectacle: "Heavy salvage objects swing through a collapsing station.",
  setting: "Orbital salvage station",
  artDirection: "Readable industrial shapes and high-contrast interactables",
  camera: "Close third-person chase camera",
  readability: "Split control indicators show each player's contribution.",
  noveltyAxes: [
    { axis: "dependency_type", choice: "shared_system", whyDifferent: "Coupled controls" },
    { axis: "social_tension", choice: "blame", whyDifferent: "Mistakes propagate" },
  ],
  buildability: {
    networking: "medium" as const,
    physics: "medium" as const,
    contentBurden: "low" as const,
    npcAiDependency: "none" as const,
    systemicInteractions: "medium" as const,
    mainRisks: ["networked physics"],
    mvpRead: "One room, one machine, one salvage objective.",
  },
  referenceInfluences: [],
};

function context(overrides: Partial<WorkflowTickContext> = {}): WorkflowTickContext {
  return {
    jobId: "job-1",
    workflowKind: "game_discovery_batch",
    workflowVersion: 1,
    currentStage: "objective_ready",
    state: {
      creative_run_id: "creative-run-1",
      discovery_objective: objective,
    },
    retryCount: 0,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("game_discovery_batch@1 workflow", () => {
  it("validates the objective and schedules the Concept Explorer tick", async () => {
    const result = await gameDiscoveryBatchV1(context());

    expect(result.status).toBe("waiting");
    expect(result.currentStage).toBe("concept_generation_pending");
    expect(result.progress).toBe(10);
    expect(result.nextActionAt).toEqual(expect.any(String));
    expect(result.enqueueReason).toBe("concept_generation");
    expect(result.stateReason).toBe("s4_002_ready_for_concept_explorer");
    expect(result.eventType).toBe("discovery.objective_ready");
  });

  it("resumes from already-persisted concepts and wakes pre-evaluation without repeating the LLM call", async () => {
    let llmCalls = 0;
    const result = await gameDiscoveryBatchV1(
      context({
        currentStage: "concept_generation_pending",
        services: {
          gameDiscovery: {
            getConceptStage: async () => ({
              persisted: true,
              acceptedConcepts: [concept],
              conceptRuns: [{ runId: "concept-run-1", conceptId: "concept-1" }],
              explorerMetadata: { model: "claude-sonnet-5" },
              rejectionCount: 1,
            }),
          },
          kieClaude: {
            generate: async () => {
              llmCalls += 1;
              throw new Error("should not be called");
            },
          },
        } as unknown as NonNullable<WorkflowTickContext["services"]>,
      }),
    );

    expect(llmCalls).toBe(0);
    expect(result.status).toBe("waiting");
    expect(result.currentStage).toBe("pre_evaluation_pending");
    expect(result.progress).toBe(35);
    expect(result.nextActionAt).toEqual(expect.any(String));
    expect(result.enqueueReason).toBe("concept_pre_evaluation");
    expect(result.stateReason).toBe("s4_003_resumed_from_persisted_concepts");
  });

  it("parks durably after gameplay moments while shot planning is not enabled", async () => {
    const result = await gameDiscoveryBatchV1(
      context({ currentStage: "shot_planning_pending" }),
    );

    expect(result.status).toBe("waiting");
    expect(result.currentStage).toBe("shot_planning_pending");
    expect(result.nextActionAt).toBeNull();
    expect(result.stateReason).toBe("s4_004_shot_planner_not_enabled_yet");
  });

  it("fails closed on corrupted durable admission state", async () => {
    const result = await gameDiscoveryBatchV1(
      context({ state: { discovery_objective: { schema: "wrong" } } }),
    );

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "DISCOVERY_OBJECTIVE_INVALID" });
  });

  it("fails closed on unknown stages", async () => {
    const result = await gameDiscoveryBatchV1(context({ currentStage: "mystery_stage" }));

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "DISCOVERY_STAGE_UNSUPPORTED" });
  });
});
