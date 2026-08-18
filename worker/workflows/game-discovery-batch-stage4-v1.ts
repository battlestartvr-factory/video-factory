import { createHash } from "node:crypto";
import { compileGameplayPromptPlans } from "../../lib/game-discovery/prompt-compiler";
import { discoveryObjectiveSpecV1Schema } from "../../lib/game-discovery/schemas";
import { planGameplayShots } from "../../lib/game-discovery/shot-planner";
import { DurableWorkflowError } from "../../lib/orchestrator/retry";
import { KieClaudeTaskError } from "../../lib/models/kie/claude-task";
import { gameDiscoveryBatchV1 } from "./game-discovery-batch-v1";
import type { WorkflowTickContext, WorkflowTickHandler } from "./types";

const REFERENCE_POLL_MS = 5_000;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nextAt(delayMs: number): string {
  return new Date(Date.now() + delayMs).toISOString();
}

function stableUuid(seed: string): string {
  const bytes = Buffer.from(createHash("sha256").update(seed).digest("hex").slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function repositoryRuntime(context: WorkflowTickContext) {
  if (!context.services?.gameDiscovery) {
    throw new DurableWorkflowError({
      code: "DISCOVERY_REPOSITORY_MISSING",
      message: "Stage 4 game discovery repository is not configured",
      retryable: false,
    });
  }
  return context.services.gameDiscovery;
}

function shotRuntime(context: WorkflowTickContext) {
  const repository = repositoryRuntime(context);
  if (!context.services?.kieClaude) {
    throw new DurableWorkflowError({
      code: "KIE_NOT_CONFIGURED",
      message: "KIE_API_KEY is required for Stage 4 shot planning",
      retryable: false,
    });
  }
  return { repository, claude: context.services.kieClaude };
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

const EXTENDED_STAGES = new Set([
  "shot_planning_pending",
  "reference_image_generation_pending",
  "reference_image_waiting",
  "human_reference_approval_pending",
  "reference_revision_pending",
  "video_generation_pending",
]);

export const gameDiscoveryBatchStage4V1: WorkflowTickHandler = async (context) => {
  if (!context.currentStage || !EXTENDED_STAGES.has(context.currentStage)) {
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
        message: "Visual discovery stages are missing a valid discovery objective or creative run id",
      },
      stateReason: "invalid_discovery_visual_state",
      eventType: "discovery.visual_state_invalid",
    };
  }

  if (context.currentStage === "reference_image_generation_pending") {
    const repository = repositoryRuntime(context);
    let visual;
    let referenceStage;
    try {
      [visual, referenceStage] = await Promise.all([
        repository.getVisualStage({ rootCreativeRunId }),
        repository.getReferenceImageStage({ rootCreativeRunId }),
      ]);
    } catch (error) {
      throw persistenceError("REFERENCE_IMAGE_ADMISSION_RESUME_CHECK_FAILED", error);
    }

    if (!visual.shots.length || visual.promptPlans.length !== visual.shots.length) {
      throw new DurableWorkflowError({
        code: "REFERENCE_IMAGE_PLAN_MISSING",
        message: "Reference image generation requires a complete ShotSpec/PromptPlan set",
        retryable: false,
      });
    }

    const existingShotIds = new Set(referenceStage.items.map((item) => item.shotId));
    const admissions: Array<{ shotId: string; generationId: string; factoryJobId: string }> = [];
    for (const shot of visual.shots) {
      if (existingShotIds.has(shot.shotId)) continue;
      const promptPlan = visual.promptPlans.find((plan) => plan.shotId === shot.shotId);
      if (!promptPlan?.imagePrompt) {
        throw new DurableWorkflowError({
          code: "REFERENCE_IMAGE_PROMPT_MISSING",
          message: `Reference image prompt is missing for shot ${shot.shotId}`,
          retryable: false,
        });
      }
      const requestId = stableUuid(`stage4-reference:${context.jobId}:${shot.shotId}:v1`);
      try {
        const admission = await repository.createReferenceImage({
          rootJobId: context.jobId,
          rootCreativeRunId,
          requestId,
          conceptId: promptPlan.conceptId,
          momentId: promptPlan.momentId,
          shotId: shot.shotId,
          prompt: promptPlan.imagePrompt,
          modelId: shot.generationPlan.imageModel ?? "nano-banana-2",
        });
        admissions.push({
          shotId: shot.shotId,
          generationId: admission.generationId,
          factoryJobId: admission.factoryJobId,
        });
      } catch (error) {
        // Stable request IDs make admission retry safe. If a database commit succeeded before
        // transport failure, the next tick reconciles the root's persisted request map first.
        throw persistenceError("REFERENCE_IMAGE_ADMISSION_FAILED", error);
      }
    }

    return {
      status: "waiting",
      currentStage: "reference_image_waiting",
      progress: 80,
      nextActionAt: nextAt(REFERENCE_POLL_MS),
      enqueueReason: "reference_image_reconcile",
      state: {
        ...context.state,
        reference_image_admissions: admissions,
        reference_approval_required: true,
        video_generation_locked: true,
      },
      stateReason: "s4_005_reference_images_admitted",
      eventType: "discovery.reference_images_admitted",
      eventPayload: {
        admitted_count: admissions.length,
        expected_count: visual.shots.length,
        image_model_policy: "shot_generation_plan",
        image_quality: "1K",
        video_generation_locked: true,
      },
    };
  }

  if (context.currentStage === "reference_image_waiting") {
    const repository = repositoryRuntime(context);
    let referenceStage;
    try {
      referenceStage = await repository.getReferenceImageStage({ rootCreativeRunId });
    } catch (error) {
      throw persistenceError("REFERENCE_IMAGE_RECONCILE_FAILED", error);
    }

    if (!referenceStage.requestCount) {
      return {
        status: "waiting",
        currentStage: "reference_image_generation_pending",
        progress: 75,
        nextActionAt: new Date().toISOString(),
        enqueueReason: "reference_image_admission_recover",
        state: context.state,
        stateReason: "s4_005_reference_admission_missing_recover",
      };
    }

    const failed = referenceStage.items.filter(
      (item) => item.status === "failed" || item.status === "cancelled",
    );
    if (failed.length) {
      return {
        status: "failed",
        currentStage: "reference_image_failed",
        progress: 80,
        state: {
          ...context.state,
          reference_images: referenceStage.items,
          video_generation_locked: true,
        },
        error: {
          code: "REFERENCE_IMAGE_FAILED",
          message: `Reference image generation failed for ${failed.map((item) => item.shotId).join(", ")}`,
          retryable: false,
        },
        stateReason: "s4_005_reference_image_failed_video_locked",
        eventType: "discovery.reference_image_failed",
        eventPayload: { failed_shot_ids: failed.map((item) => item.shotId) },
      };
    }

    if (!referenceStage.allCompleted) {
      return {
        status: "waiting",
        currentStage: "reference_image_waiting",
        progress: 82,
        nextActionAt: nextAt(REFERENCE_POLL_MS),
        enqueueReason: "reference_image_reconcile",
        state: {
          ...context.state,
          reference_images: referenceStage.items,
          reference_approval_required: true,
          video_generation_locked: true,
        },
        stateReason: "s4_005_reference_images_processing",
        eventType: "discovery.reference_images_processing",
        eventPayload: {
          completed_count: referenceStage.items.filter((item) => item.status === "completed").length,
          expected_count: referenceStage.requestCount,
        },
      };
    }

    return {
      status: "waiting",
      currentStage: "human_reference_approval_pending",
      progress: 85,
      nextActionAt: null,
      state: {
        ...context.state,
        reference_images: referenceStage.items,
        reference_images_completed_at: new Date().toISOString(),
        reference_approval_required: true,
        video_generation_locked: true,
      },
      stateReason: "s4_005_reference_images_ready_for_human_review",
      eventType: "discovery.reference_images_ready_for_review",
      eventPayload: {
        reference_count: referenceStage.items.length,
        generation_ids: referenceStage.items.map((item) => item.generationId),
        video_generation_locked: true,
      },
    };
  }

  if (context.currentStage === "human_reference_approval_pending") {
    const repository = repositoryRuntime(context);
    let approvals;
    try {
      approvals = await repository.getReferenceApprovalStage({ rootCreativeRunId });
    } catch (error) {
      throw persistenceError("REFERENCE_APPROVAL_RECONCILE_FAILED", error);
    }

    const revised = approvals.items.filter((item) => item.decision === "revise");
    if (revised.length) {
      return {
        status: "waiting",
        currentStage: "reference_revision_pending",
        progress: 86,
        nextActionAt: null,
        state: {
          ...context.state,
          reference_approvals: approvals.items,
          revision_shot_ids: revised.map((item) => item.shotId),
          reference_approval_required: true,
          video_generation_locked: true,
        },
        stateReason: "s4_005_reference_revision_requested_feedback_saved",
        eventType: "discovery.reference_revision_requested",
        eventPayload: {
          revision_shot_ids: revised.map((item) => item.shotId),
          video_generation_locked: true,
        },
      };
    }

    if (!approvals.allReviewed) {
      return {
        status: "waiting",
        currentStage: "human_reference_approval_pending",
        progress: 85,
        nextActionAt: null,
        state: {
          ...context.state,
          reference_approvals: approvals.items,
          reference_approval_required: true,
          video_generation_locked: true,
        },
        stateReason: "s4_005_waiting_for_human_reference_review",
      };
    }

    const approved = approvals.items.filter((item) => item.decision === "approve");
    const rejected = approvals.items.filter((item) => item.decision === "reject");
    if (!approved.length) {
      return {
        status: "completed",
        currentStage: "reference_rejected_no_video",
        progress: 100,
        state: {
          ...context.state,
          reference_approvals: approvals.items,
          approved_reference_generation_ids: [],
          rejected_reference_generation_ids: rejected.map((item) => item.generationId),
          video_generation_locked: true,
        },
        result: {
          prototype_candidates: 0,
          rejected_reference_count: rejected.length,
          reason: "human_rejected_all_gameplay_references",
        },
        stateReason: "s4_005_all_references_rejected_no_video_spend",
        eventType: "discovery.references_rejected",
      };
    }

    return {
      status: "waiting",
      currentStage: "video_generation_pending",
      progress: 88,
      nextActionAt: null,
      state: {
        ...context.state,
        reference_approvals: approvals.items,
        approved_reference_generation_ids: approved.map((item) => item.generationId),
        approved_reference_shot_ids: approved.map((item) => item.shotId),
        rejected_reference_generation_ids: rejected.map((item) => item.generationId),
        reference_approval_required: true,
        human_reference_gate_passed: true,
        video_generation_locked: false,
      },
      stateReason: "s4_005_human_reference_gate_passed_video_ready",
      eventType: "discovery.reference_gate_passed",
      eventPayload: {
        approved_generation_ids: approved.map((item) => item.generationId),
        rejected_generation_ids: rejected.map((item) => item.generationId),
        video_generation_locked: false,
      },
    };
  }

  if (context.currentStage === "reference_revision_pending") {
    return {
      status: "waiting",
      currentStage: "reference_revision_pending",
      progress: 86,
      nextActionAt: null,
      state: {
        ...context.state,
        video_generation_locked: true,
      },
      stateReason: "s4_005_targeted_reference_revision_not_enabled_yet",
      eventType: "discovery.reference_revision_parked",
    };
  }

  if (context.currentStage === "video_generation_pending") {
    return {
      status: "waiting",
      currentStage: "video_generation_pending",
      progress: 88,
      nextActionAt: null,
      state: context.state,
      stateReason: "s4_005_video_fanout_not_enabled_yet",
      eventType: "discovery.video_generation_guarded",
      eventPayload: {
        human_reference_gate_passed: context.state.human_reference_gate_passed === true,
      },
    };
  }

  const services = shotRuntime(context);
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
      nextActionAt: new Date().toISOString(),
      enqueueReason: "reference_image_admission",
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
    nextActionAt: completedAt,
    enqueueReason: "reference_image_admission",
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
