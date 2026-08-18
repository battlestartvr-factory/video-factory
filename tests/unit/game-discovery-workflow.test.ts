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
    expect(result.eventPayload).toMatchObject({
      creative_run_id: "creative-run-1",
      objective_id: "objective-1",
      concept_count: 6,
      max_concepts_to_prototype: 2,
    });
  });

  it("resumes from already-persisted concepts without repeating the LLM call", async () => {
    let llmCalls = 0;
    const result = await gameDiscoveryBatchV1(
      context({
        currentStage: "concept_generation_pending",
        services: {
          gameDiscovery: {
            getConceptStage: async () => ({
              persisted: true,
              acceptedConcepts: [],
              conceptRuns: [
                { runId: "concept-run-1", conceptId: "concept-1" },
                { runId: "concept-run-2", conceptId: "concept-2" },
              ],
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
    expect(result.stateReason).toBe("s4_003_resumed_from_persisted_concepts");
  });

  it("parks durably after S4-003 while S4-004 is not enabled", async () => {
    const result = await gameDiscoveryBatchV1(
      context({ currentStage: "pre_evaluation_pending" }),
    );

    expect(result.status).toBe("waiting");
    expect(result.currentStage).toBe("pre_evaluation_pending");
    expect(result.nextActionAt).toBeNull();
    expect(result.stateReason).toBe("s4_004_not_enabled_yet");
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
