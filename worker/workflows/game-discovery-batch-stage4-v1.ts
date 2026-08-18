import { compileGameplayPromptPlans } from "../../lib/game-discovery/prompt-compiler";
import { discoveryObjectiveSpecV1Schema } from "../../lib/game-discovery/schemas";
import { planGameplayShots } from "../../lib/game-discovery/shot-planner";
import { DurableWorkflowError } from "../../lib/orchestrator/retry";
import { KieClaudeTaskError } from "../../lib/models/kie/claude-task";
import { gameDiscoveryBatchV1 } from "./game-discovery-batch-v1";
import type { WorkflowTickContext, WorkflowTickHandler } from "./types";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function runtime(context: WorkflowTickContext) {
  if (!context.services?.gameDiscovery) {
    throw new DurableWorkflowError({
      code: "DISCOVERY_REPOSITORY_MISSING",
      message: "Stage 4 game discovery repository is not configured",
      retryable: false,
    });
  }
  if (!context.services.kieClaude) {
    throw new DurableWorkflowError({
      code: "KIE_NOT_CONFIGURED",
      message: "KIE_API_KEY is required for Stage 4 shot planning",
      retryable: false,
    });
  }
  return { repository: context.services.gameDiscovery, claude: context.services.kieClaude };
}

function persistenceError(code: string, error: unknown): DurableWorkflowError {
  return new DurableWorkflowError({
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    retryAfterMs: 5_000,
    cause: error,
  });
}

export const gameDiscoveryBatchStage4V1: WorkflowTickHandler = async (context) => {
  if (
    context.currentStage !== "shot_planning_pending" &&
    context.currentStage !== "reference_image_generation_pending"
  ) {
    return gameDiscoveryBatchV1(context);
  }

  const objective = discoveryObjectiveSpecV1Schema.safeParse(context.state.discovery_objective);
  const rootCreativeRunId = text(context.state.creative_run_id);
  if (!objective.success || !rootCreativeRunId) {
    return {
      status: "failed",
      currentStage: context.currentStage,
      progress: 65,
      error: {
        code: "DISCOVERY_OBJECTIVE_INVALID",
        message: "Shot planning is missing a valid discovery objective or creative run id",
      },
      stateReason: "invalid_discovery_visual_state",
      eventType: "discovery.visual_state_invalid",
    };
  }

  if (context.currentStage === "reference_image_generation_pending") {
    return {
      status: "waiting",
      currentStage: "reference_image_generation_pending",
      progress: Math.max(75, Number(context.state.progress ?? 75)),
      nextActionAt: null,
      state: {
        ...context.state,
        reference_approval_required: true,
        video_generation_locked: true,
      },
      stateReason: "s4_005_reference_generation_waits_for_approval_surface",
      eventType: "discovery.reference_generation_guarded",
      eventPayload: {
        reference_approval_required: true,
        video_generation_locked: true,
      },
    };
  }

  const services = runtime(context);
  let visual;
  let planning;
  let concepts;
  let feedback;
  try {
    [visual, planning, concepts, feedback] = await Promise.all([
      services.repository.getVisualStage({ rootCreativeRunId }),
      services.repository.getPlanningStage({ rootCreativeRunId }),
      services.repository.getConceptStage({ rootCreativeRunId }),
      services.repository.getFeedbackMemory({ rootCreativeRunId }),
    ]);
  } catch (error) {
    throw persistenceError("SHOT_PLANNING_RESUME_CHECK_FAILED", error);
  }

  if (visual.shots.length > 0 && visual.promptPlans.length === visual.shots.length) {
    return {
      status: "waiting",
      currentStage: "reference_image_generation_pending",
      progress: 75,
      nextActionAt: null,
      state: {
        ...context.state,
        gameplay_shots: visual.shots,
        prompt_plans: visual.promptPlans,
        shot_planner: visual.shotPlannerMetadata,
        prompt_compiler: visual.promptCompilerMetadata,
        reference_approval_required: true,
        video_generation_locked: true,
      },
      stateReason: "s4_004_resumed_from_persisted_shots_prompts",
      eventType: "discovery.shots_prompts_resumed",
    };
  }

  if (!planning.moments.length) {
    throw new DurableWorkflowError({
      code: "SHOT_PLANNER_MOMENTS_MISSING",
      message: "Shot Planner requires persisted GameplayMomentSpec records",
      retryable: false,
    });
  }

  const selectedConceptIds = planning.selectedConceptIds.length
    ? planning.selectedConceptIds
    : Array.isArray(context.state.selected_concept_ids)
      ? context.state.selected_concept_ids.filter((value): value is string => typeof value === "string")
      : [];

  const selectedConcepts = selectedConceptIds.map((conceptId) => {
    const concept = concepts.acceptedConcepts.find((item) => item.conceptId === conceptId);
    if (!concept) {
      throw new DurableWorkflowError({
        code: "SHOT_PLANNER_CONCEPT_MISSING",
        message: `Selected concept ${conceptId} is missing from the persisted concept stage`,
        retryable: false,
      });
    }
    return concept;
  });

  let shotPlanning;
  try {
    shotPlanning = await planGameplayShots({
      llm: services.claude,
      objective: objective.data,
      concepts: selectedConcepts,
      moments: planning.moments,
      feedbackMemory: feedback,
      signal: context.signal,
    });
  } catch (error) {
    if (error instanceof KieClaudeTaskError) {
      throw new DurableWorkflowError({
        code: "SHOT_PLANNER_PROVIDER_FAILED",
        message: error.message,
        retryable: error.retryable,
        retryAfterMs: error.retryable ? 5_000 : undefined,
        details: { http_status: error.status },
        cause: error,
      });
    }
    if (context.signal.aborted) throw error;
    throw new DurableWorkflowError({
      code: "SHOT_PLANNER_FAILED",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      cause: error,
    });
  }

  const promptPlans = compileGameplayPromptPlans({
    concepts: selectedConcepts,
    moments: planning.moments,
    shots: shotPlanning.shots,
    feedbackMemory: feedback,
  });

  try {
    await services.repository.persistShotsAndPrompts({
      jobId: context.jobId,
      rootCreativeRunId,
      result: shotPlanning,
      promptPlans,
    });
  } catch (error) {
    throw persistenceError("SHOT_PROMPT_PERSIST_FAILED", error);
  }

  const completedAt = new Date().toISOString();
  return {
    status: "waiting",
    currentStage: "reference_image_generation_pending",
    progress: 75,
    nextActionAt: null,
    state: {
      ...context.state,
      gameplay_shots: shotPlanning.shots,
      prompt_plans: promptPlans,
      shot_planning_completed_at: completedAt,
      shot_planner: {
        model: shotPlanning.model,
        repair_model: shotPlanning.repairModel,
        escalated: shotPlanning.escalated,
        usage: shotPlanning.usage,
        raw_response_hashes: shotPlanning.rawResponseHashes,
      },
      prompt_compiler: {
        compiler: "gameplay_prompt_compiler_v1",
        llm_calls: 0,
      },
      feedback_memory_applied: feedback,
      reference_approval_required: true,
      video_generation_locked: true,
    },
    stateReason: "s4_004_shots_prompts_ready_reference_gate_locked",
    eventType: "discovery.shots_prompts_ready",
    eventPayload: {
      shot_ids: shotPlanning.shots.map((shot) => shot.shotId),
      prompt_plan_count: promptPlans.length,
      shot_planner_model: shotPlanning.model,
      shot_planner_escalated: shotPlanning.escalated,
      prompt_compiler_llm_calls: 0,
      feedback_rule_count:
        feedback.mustShow.length + feedback.mustAvoid.length + feedback.errorTags.length,
      reference_approval_required: true,
      video_generation_locked: true,
    },
  };
};
