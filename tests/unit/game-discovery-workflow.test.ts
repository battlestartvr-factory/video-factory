import { describe, expect, it } from "vitest";
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

function context(overrides: Record<string, unknown> = {}) {
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

describe("game_discovery_batch@1 workflow skeleton", () => {
  it("validates the objective and parks durably before concept generation", async () => {
    const result = await gameDiscoveryBatchV1(context());

    expect(result.status).toBe("waiting");
    expect(result.currentStage).toBe("concept_generation_pending");
    expect(result.progress).toBe(10);
    expect(result.nextActionAt).toBeNull();
    expect(result.stateReason).toBe("s4_002_ready_for_concept_explorer");
    expect(result.eventType).toBe("discovery.objective_ready");
    expect(result.eventPayload).toMatchObject({
      creative_run_id: "creative-run-1",
      objective_id: "objective-1",
      concept_count: 6,
      max_concepts_to_prototype: 2,
    });
  });

  it("is stable when woken again before S4-003 is enabled", async () => {
    const result = await gameDiscoveryBatchV1(
      context({ currentStage: "concept_generation_pending" }),
    );

    expect(result.status).toBe("waiting");
    expect(result.currentStage).toBe("concept_generation_pending");
    expect(result.nextActionAt).toBeNull();
    expect(result.stateReason).toBe("s4_003_not_enabled_yet");
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
