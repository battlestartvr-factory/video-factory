import { exploreConcepts } from "../../lib/game-discovery/concept-explorer";
import { discoveryObjectiveSpecV1Schema } from "../../lib/game-discovery/schemas";
import { DurableWorkflowError } from "../../lib/orchestrator/retry";
import { KieClaudeTaskError } from "../../lib/models/kie/claude-task";
import type { WorkflowTickContext, WorkflowTickHandler } from "./types";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireConceptRuntime(context: WorkflowTickContext) {
  if (!context.services) {
    throw new DurableWorkflowError({
      code: "DISCOVERY_RUNTIME_MISSING",
      message: "game_discovery_batch@1 requires durable worker services",
      retryable: false,
    });
  }
  if (!context.services.gameDiscovery) {
    throw new DurableWorkflowError({
      code: "DISCOVERY_REPOSITORY_MISSING",
      message: "Stage 4 game discovery repository is not configured in the durable worker",
      retryable: false,
    });
  }
  if (!context.services.kieClaude) {
    throw new DurableWorkflowError({
      code: "KIE_NOT_CONFIGURED",
      message: "KIE_API_KEY is required for the Stage 4 Concept Explorer",
      retryable: false,
    });
  }
  return {
    repository: context.services.gameDiscovery,
    claude: context.services.kieClaude,
  };
}

function providerFailure(error: KieClaudeTaskError): DurableWorkflowError {
  return new DurableWorkflowError({
    code: "CONCEPT_EXPLORER_PROVIDER_FAILED",
    message: error.message,
    retryable: error.retryable,
    retryAfterMs: error.retryable ? 5_000 : undefined,
    details: { http_status: error.status },
    cause: error,
  });
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
      nextActionAt: now,
      enqueueReason: "concept_generation",
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
    const runtime = requireConceptRuntime(context);

    let persisted;
    try {
      persisted = await runtime.repository.getConceptStage({ rootCreativeRunId: creativeRunId });
    } catch (error) {
      throw new DurableWorkflowError({
        code: "CONCEPT_STAGE_RESUME_CHECK_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        retryAfterMs: 5_000,
        cause: error,
      });
    }

    if (persisted.persisted) {
      return {
        status: "waiting",
        currentStage: "pre_evaluation_pending",
        progress: 35,
        nextActionAt: null,
        state: {
          ...context.state,
          concept_ids: persisted.acceptedConcepts.map((concept) => concept.conceptId),
          concept_run_ids: persisted.conceptRuns.map((run) => run.runId),
          concept_count_accepted: persisted.acceptedConcepts.length,
          concept_count_rejected: persisted.rejectionCount,
          concept_explorer: persisted.explorerMetadata,
          concept_generation_completed_at:
            text(context.state.concept_generation_completed_at) ?? new Date().toISOString(),
        },
        stateReason: "s4_003_resumed_from_persisted_concepts",
        eventType: "discovery.concepts_resumed",
        eventPayload: {
          creative_run_id: creativeRunId,
          accepted_count: persisted.acceptedConcepts.length,
          concept_run_ids: persisted.conceptRuns.map((run) => run.runId),
        },
      };
    }

    let history;
    try {
      history = await runtime.repository.getConceptHistory({
        rootCreativeRunId: creativeRunId,
        limit: 200,
      });
    } catch (error) {
      throw new DurableWorkflowError({
        code: "CONCEPT_HISTORY_LOAD_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        retryAfterMs: 5_000,
        cause: error,
      });
    }

    let exploration;
    try {
      exploration = await exploreConcepts({
        llm: runtime.claude,
        objective: objectiveResult.data,
        history,
        model: "claude-sonnet-5",
        replacementBuffer: 2,
        maxReplacementAttempts: 3,
        signal: context.signal,
      });
    } catch (error) {
      if (error instanceof KieClaudeTaskError) throw providerFailure(error);
      if (context.signal.aborted) throw error;
      throw new DurableWorkflowError({
        code: "CONCEPT_EXPLORER_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        cause: error,
      });
    }

    let conceptRuns;
    try {
      conceptRuns = await runtime.repository.persistConceptExploration({
        jobId: context.jobId,
        rootCreativeRunId: creativeRunId,
        result: exploration,
      });
    } catch (error) {
      // Persistence can have committed before a transport failure. The next tick first calls
      // getConceptStage(), so retrying this parent tick does not automatically repeat the LLM call.
      throw new DurableWorkflowError({
        code: "CONCEPT_EXPLORATION_PERSIST_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        retryAfterMs: 5_000,
        cause: error,
      });
    }

    const completedAt = new Date().toISOString();
    return {
      status: "waiting",
      currentStage: "pre_evaluation_pending",
      progress: 35,
      nextActionAt: null,
      state: {
        ...context.state,
        concept_ids: exploration.accepted.map((concept) => concept.conceptId),
        concept_run_ids: conceptRuns.map((run) => run.runId),
        concept_count_generated: exploration.generatedCount,
        concept_count_accepted: exploration.accepted.length,
        concept_count_rejected: exploration.rejected.length,
        concept_replacement_attempts: exploration.replacementAttempts,
        concept_generation_completed_at: completedAt,
        concept_explorer: {
          model: exploration.model,
          usage: exploration.usage,
          raw_response_hashes: exploration.rawResponseHashes,
        },
      },
      stateReason: "s4_003_concept_explorer_complete",
      eventType: "discovery.concepts_ready",
      eventPayload: {
        creative_run_id: creativeRunId,
        objective_id: objectiveResult.data.objectiveId,
        generated_count: exploration.generatedCount,
        accepted_count: exploration.accepted.length,
        rejected_count: exploration.rejected.length,
        replacement_attempts: exploration.replacementAttempts,
        concept_ids: exploration.accepted.map((concept) => concept.conceptId),
        concept_run_ids: conceptRuns.map((run) => run.runId),
        history_count: history.length,
        model: exploration.model,
        usage: exploration.usage,
      },
    };
  }

  if (context.currentStage === "pre_evaluation_pending") {
    return {
      status: "waiting",
      currentStage: "pre_evaluation_pending",
      progress: Math.max(35, Number(context.state.progress ?? 35)),
      nextActionAt: null,
      state: context.state,
      stateReason: "s4_004_not_enabled_yet",
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
