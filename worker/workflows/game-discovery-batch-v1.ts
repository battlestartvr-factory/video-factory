import { discoveryObjectiveSpecV1Schema } from "../../lib/game-discovery/schemas";
import type { WorkflowTickHandler } from "./types";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const gameDiscoveryBatchV1: WorkflowTickHandler = async (context) => {
  const objectiveResult = discoveryObjectiveSpecV1Schema.safeParse(context.state.discovery_objective);
  const creativeRunId = text(context.state.creative_run_id);

  if (!objectiveResult.success || !creativeRunId) {
    return {
      status: "failed",
      currentStage: context.currentStage ?? "objective_ready",
      progress: 0,
      error: {
        code: "DISCOVERY_OBJECTIVE_INVALID",
        message: "Durable discovery job is missing a valid objective or creative run id",
      },
      stateReason: "invalid_discovery_admission_state",
      eventType: "discovery.objective_invalid",
    };
  }

  if (!context.currentStage || context.currentStage === "objective_ready") {
    const now = new Date().toISOString();
    return {
      status: "waiting",
      currentStage: "concept_generation_pending",
      progress: 10,
      nextActionAt: null,
      state: {
        ...context.state,
        creative_run_id: creativeRunId,
        discovery_objective: objectiveResult.data,
        objective_validated_at: now,
        stage4_schema_version: 1,
      },
      stateReason: "s4_002_ready_for_concept_explorer",
      eventType: "discovery.objective_ready",
      eventPayload: {
        creative_run_id: creativeRunId,
        objective_id: objectiveResult.data.objectiveId,
        concept_count: objectiveResult.data.conceptCount,
        max_concepts_to_prototype: objectiveResult.data.maxConceptsToPrototype,
      },
    };
  }

  if (context.currentStage === "concept_generation_pending") {
    return {
      status: "waiting",
      currentStage: "concept_generation_pending",
      progress: Math.max(10, Number(context.state.progress ?? 10)),
      nextActionAt: null,
      state: context.state,
      stateReason: "s4_003_not_enabled_yet",
    };
  }

  return {
    status: "failed",
    currentStage: context.currentStage,
    progress: 10,
    error: {
      code: "DISCOVERY_STAGE_UNSUPPORTED",
      message: `Unsupported game discovery stage: ${context.currentStage}`,
    },
    stateReason: "unsupported_discovery_stage",
    eventType: "discovery.stage_unsupported",
  };
};
