import { createHash } from "node:crypto";
import { buildGameplayAssetGraph } from "../../lib/game-discovery/asset-graph";
import { compileGameplayPromptPlans } from "../../lib/game-discovery/prompt-compiler";
import { DurableWorkflowError } from "../../lib/orchestrator/retry";
import { gameDiscoveryBatchStage4V1 } from "./game-discovery-batch-stage4-v1";
import type { WorkflowTickContext, WorkflowTickHandler, WorkflowTickOutcome } from "./types";

const VIDEO_POLL_MS = 5_000;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function revisionCounts(state: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(object(state.video_revision_numbers)).map(([key, value]) => [
      key,
      typeof value === "number" ? Math.max(0, Math.trunc(value)) : 0,
    ]),
  );
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

function persistenceError(code: string, error: unknown): DurableWorkflowError {
  return new DurableWorkflowError({
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    retryAfterMs: 5_000,
    cause: error,
  });
}

function runtime(context: WorkflowTickContext) {
  const gameDiscovery = context.services?.gameDiscovery;
  const video = context.services?.gameDiscoveryVideo;
  if (!gameDiscovery || !video) {
    throw new DurableWorkflowError({
      code: "DISCOVERY_VIDEO_REPOSITORY_MISSING",
      message: "Stage 4 approved gameplay video repositories are not configured",
      retryable: false,
    });
  }
  return { gameDiscovery, video };
}

function failedOutcome(input: {
  context: WorkflowTickContext;
  currentStage: string;
  code: string;
  message: string;
  stateReason: string;
  eventType: string;
  eventPayload?: Record<string, unknown>;
}): WorkflowTickOutcome {
  return {
    status: "failed",
    currentStage: input.currentStage,
    progress: 92,
    state: {
      ...input.context.state,
      video_generation_locked: true,
    },
    error: {
      code: input.code,
      message: input.message,
      retryable: false,
    },
    stateReason: input.stateReason,
    eventType: input.eventType,
    eventPayload: input.eventPayload,
  };
}

async function handleVideoPending(context: WorkflowTickContext): Promise<WorkflowTickOutcome> {
  const rootCreativeRunId = text(context.state.creative_run_id);
  if (!rootCreativeRunId) {
    return failedOutcome({
      context,
      currentStage: "video_generation_pending",
      code: "DISCOVERY_VIDEO_ROOT_MISSING",
      message: "Approved gameplay video fan-out is missing the root creative run id",
      stateReason: "s4_005b_video_root_missing",
      eventType: "discovery.gameplay_video_guard_failed",
    });
  }
  if (context.state.human_reference_gate_passed !== true) {
    return failedOutcome({
      context,
      currentStage: "video_generation_pending",
      code: "DISCOVERY_VIDEO_HUMAN_GATE_REQUIRED",
      message: "Gameplay video generation requires a completed human reference approval gate",
      stateReason: "s4_005b_video_human_gate_missing",
      eventType: "discovery.gameplay_video_guard_failed",
    });
  }

  const services = runtime(context);
  let approvals;
  let videoStage;
  try {
    [approvals, videoStage] = await Promise.all([
      services.gameDiscovery.getReferenceApprovalStage({ rootCreativeRunId }),
      services.video.getGameplayVideoStage({ rootCreativeRunId }),
    ]);
  } catch (error) {
    throw persistenceError("GAMEPLAY_VIDEO_ADMISSION_RESUME_CHECK_FAILED", error);
  }

  if (!approvals.allReviewed) {
    return failedOutcome({
      context,
      currentStage: "video_generation_pending",
      code: "DISCOVERY_VIDEO_APPROVALS_INCOMPLETE",
      message: "Gameplay video fan-out requires every active reference to have a human decision",
      stateReason: "s4_005b_video_approval_set_incomplete",
      eventType: "discovery.gameplay_video_guard_failed",
    });
  }

  const approved = approvals.items.filter((item) => item.decision === "approve");
  if (!approved.length) {
    return {
      status: "completed",
      currentStage: "reference_rejected_no_video",
      progress: 100,
      state: {
        ...context.state,
        approved_reference_generation_ids: [],
        video_generation_locked: true,
      },
      result: {
        prototype_candidates: 0,
        reason: "no_current_human_approved_references",
      },
      stateReason: "s4_005b_no_approved_references_no_video_spend",
      eventType: "discovery.references_rejected",
    };
  }

  const existingByShot = new Map(videoStage.items.map((item) => [item.shotId, item]));
  for (const item of approved) {
    const existing = existingByShot.get(item.shotId);
    if (existing && existing.approvedReferenceGenerationId !== item.generationId) {
      return failedOutcome({
        context,
        currentStage: "video_generation_pending",
        code: "DISCOVERY_VIDEO_STALE_REFERENCE",
        message: `Existing gameplay video for shot ${item.shotId} is tied to a stale reference generation`,
        stateReason: "s4_005b_stale_approved_reference_detected",
        eventType: "discovery.gameplay_video_guard_failed",
        eventPayload: {
          shot_id: item.shotId,
          current_reference_generation_id: item.generationId,
          existing_reference_generation_id: existing.approvedReferenceGenerationId,
        },
      });
    }
  }

  const admissions: Array<{
    shotId: string;
    referenceGenerationId: string;
    generationId: string;
    factoryJobId: string;
    duplicate: boolean;
  }> = [];

  for (const item of approved) {
    if (existingByShot.has(item.shotId)) continue;
    const requestId = stableUuid(`stage4-video:${context.jobId}:${item.shotId}:${item.generationId}`);
    try {
      const admission = await services.video.createApprovedVideo({
        rootJobId: context.jobId,
        rootCreativeRunId,
        requestId,
        referenceGenerationId: item.generationId,
        shotId: item.shotId,
      });
      admissions.push({
        shotId: item.shotId,
        referenceGenerationId: item.generationId,
        generationId: admission.generationId,
        factoryJobId: admission.factoryJobId,
        duplicate: admission.duplicate,
      });
    } catch (error) {
      throw persistenceError("APPROVED_GAMEPLAY_VIDEO_ADMISSION_FAILED", error);
    }
  }

  return {
    status: "waiting",
    currentStage: "video_generation_waiting",
    progress: 91,
    nextActionAt: nextAt(VIDEO_POLL_MS),
    enqueueReason: "gameplay_video_reconcile",
    state: {
      ...context.state,
      approved_reference_generation_ids: approved.map((item) => item.generationId),
      gameplay_video_admissions: admissions,
      video_generation_locked: false,
      video_approval_required: true,
      asset_graph_locked: true,
      assembly_locked: true,
    },
    stateReason: "s4_005b_approved_gameplay_videos_admitted",
    eventType: "discovery.gameplay_videos_admitted",
    eventPayload: {
      admitted_count: admissions.length,
      existing_count: videoStage.items.length,
      expected_count: approved.length,
      approved_reference_generation_ids: approved.map((item) => item.generationId),
      human_reference_gate_passed: true,
      human_video_gate_next: true,
    },
  };
}

async function handleVideoWaiting(context: WorkflowTickContext): Promise<WorkflowTickOutcome> {
  const rootCreativeRunId = text(context.state.creative_run_id);
  if (!rootCreativeRunId) {
    return failedOutcome({
      context,
      currentStage: "video_generation_waiting",
      code: "DISCOVERY_VIDEO_ROOT_MISSING",
      message: "Gameplay video reconciliation is missing the root creative run id",
      stateReason: "s4_005b_video_root_missing",
      eventType: "discovery.gameplay_video_reconcile_failed",
    });
  }

  const services = runtime(context);
  let approvals;
  let videoStage;
  try {
    [approvals, videoStage] = await Promise.all([
      services.gameDiscovery.getReferenceApprovalStage({ rootCreativeRunId }),
      services.video.getGameplayVideoStage({ rootCreativeRunId }),
    ]);
  } catch (error) {
    throw persistenceError("GAMEPLAY_VIDEO_RECONCILE_FAILED", error);
  }

  const approved = approvals.items.filter((item) => item.decision === "approve");
  const videosByShot = new Map(videoStage.items.map((item) => [item.shotId, item]));

  for (const item of approved) {
    const video = videosByShot.get(item.shotId);
    if (video && video.approvedReferenceGenerationId !== item.generationId) {
      return failedOutcome({
        context,
        currentStage: "video_generation_waiting",
        code: "DISCOVERY_VIDEO_STALE_REFERENCE",
        message: `Gameplay video for shot ${item.shotId} no longer matches the current approved reference`,
        stateReason: "s4_005b_stale_approved_reference_detected",
        eventType: "discovery.gameplay_video_reconcile_failed",
        eventPayload: {
          shot_id: item.shotId,
          current_reference_generation_id: item.generationId,
          video_reference_generation_id: video.approvedReferenceGenerationId,
        },
      });
    }
  }

  const missing = approved.filter((item) => !videosByShot.has(item.shotId));
  if (missing.length) {
    return {
      status: "waiting",
      currentStage: "video_generation_pending",
      progress: 88,
      nextActionAt: new Date().toISOString(),
      enqueueReason: "gameplay_video_admission_recover",
      state: {
        ...context.state,
        gameplay_videos: videoStage.items,
        video_generation_locked: false,
        video_approval_required: true,
        asset_graph_locked: true,
        assembly_locked: true,
      },
      stateReason: "s4_005b_missing_video_admission_recover",
      eventType: "discovery.gameplay_video_admission_recover",
      eventPayload: { missing_shot_ids: missing.map((item) => item.shotId) },
    };
  }

  const failed = videoStage.items.filter(
    (item) => item.status === "failed" || item.status === "cancelled",
  );
  if (failed.length) {
    return failedOutcome({
      context,
      currentStage: "gameplay_video_failed",
      code: "GAMEPLAY_VIDEO_FAILED",
      message: `Gameplay video generation failed for ${failed.map((item) => item.shotId).join(", ")}`,
      stateReason: "s4_005b_gameplay_video_failed",
      eventType: "discovery.gameplay_video_failed",
      eventPayload: {
        failed_shot_ids: failed.map((item) => item.shotId),
        generation_ids: failed.map((item) => item.generationId),
      },
    });
  }

  if (!videoStage.allCompleted) {
    return {
      status: "waiting",
      currentStage: "video_generation_waiting",
      progress: 92,
      nextActionAt: nextAt(VIDEO_POLL_MS),
      enqueueReason: "gameplay_video_reconcile",
      state: {
        ...context.state,
        gameplay_videos: videoStage.items,
        video_generation_locked: false,
        video_approval_required: true,
        asset_graph_locked: true,
        assembly_locked: true,
      },
      stateReason: "s4_005b_gameplay_videos_processing",
      eventType: "discovery.gameplay_videos_processing",
      eventPayload: {
        completed_count: videoStage.items.filter((item) => item.status === "completed").length,
        expected_count: approved.length,
      },
    };
  }

  return {
    status: "waiting",
    currentStage: "human_video_approval_pending",
    progress: 93,
    nextActionAt: null,
    enqueueReason: null,
    state: {
      ...context.state,
      gameplay_videos: videoStage.items,
      gameplay_videos_completed_at: new Date().toISOString(),
      video_generation_locked: false,
      video_approval_required: true,
      human_video_gate_passed: false,
      asset_graph_locked: true,
      assembly_locked: true,
    },
    stateReason: "s4_005b_gameplay_videos_ready_for_human_review",
    eventType: "discovery.gameplay_videos_ready_for_review",
    eventPayload: {
      video_count: videoStage.items.length,
      generation_ids: videoStage.items.map((item) => item.generationId),
      human_video_gate_required: true,
      ai_video_rejection_enabled: false,
    },
  };
}

async function handleHumanVideoApproval(context: WorkflowTickContext): Promise<WorkflowTickOutcome> {
  const rootCreativeRunId = text(context.state.creative_run_id);
  if (!rootCreativeRunId) {
    return failedOutcome({
      context,
      currentStage: "human_video_approval_pending",
      code: "DISCOVERY_VIDEO_ROOT_MISSING",
      message: "Human gameplay video review is missing the root creative run id",
      stateReason: "s4_005d_video_review_root_missing",
      eventType: "discovery.gameplay_video_review_failed",
    });
  }

  const services = runtime(context);
  let approvals;
  try {
    approvals = await services.video.getGameplayVideoApprovalStage({ rootCreativeRunId });
  } catch (error) {
    throw persistenceError("GAMEPLAY_VIDEO_APPROVAL_RECONCILE_FAILED", error);
  }

  if (!approvals.allReviewed) {
    return {
      status: "waiting",
      currentStage: "human_video_approval_pending",
      progress: 93,
      nextActionAt: null,
      enqueueReason: null,
      state: {
        ...context.state,
        video_approvals: approvals.items,
        video_approval_required: true,
        human_video_gate_passed: false,
        asset_graph_locked: true,
        assembly_locked: true,
      },
      stateReason: "s4_005d_waiting_for_all_human_video_reviews",
      eventType: "discovery.gameplay_video_reviews_partial",
    };
  }

  const revised = approvals.items.filter((item) => item.decision === "revise");
  if (revised.length) {
    return {
      status: "waiting",
      currentStage: "video_revision_pending",
      progress: 93,
      nextActionAt: new Date().toISOString(),
      enqueueReason: "human_gameplay_video_revision",
      state: {
        ...context.state,
        video_approvals: approvals.items,
        video_revision_shot_ids: revised.map((item) => item.shotId),
        video_approval_required: true,
        human_video_gate_passed: false,
        asset_graph_locked: true,
        assembly_locked: true,
      },
      stateReason: "s4_005d_video_revision_requested_feedback_saved",
      eventType: "discovery.gameplay_video_revision_requested",
      eventPayload: {
        revision_shot_ids: revised.map((item) => item.shotId),
        revision_generation_ids: revised.map((item) => item.generationId),
        human_feedback_memory_saved: true,
        automatic_video_regeneration: false,
      },
    };
  }

  const approved = approvals.items.filter((item) => item.decision === "approve");
  const rejected = approvals.items.filter((item) => item.decision === "reject");
  if (!approved.length) {
    return {
      status: "completed",
      currentStage: "video_rejected_no_prototype",
      progress: 100,
      state: {
        ...context.state,
        video_approvals: approvals.items,
        approved_video_generation_ids: [],
        rejected_video_generation_ids: rejected.map((item) => item.generationId),
        video_approval_required: true,
        human_video_gate_passed: true,
        asset_graph_locked: true,
        assembly_locked: true,
      },
      result: {
        prototype_candidates: 0,
        rejected_video_count: rejected.length,
        reason: "human_rejected_all_gameplay_videos",
      },
      stateReason: "s4_005d_all_gameplay_videos_rejected_no_prototype",
      eventType: "discovery.gameplay_videos_rejected",
      eventPayload: {
        rejected_generation_ids: rejected.map((item) => item.generationId),
      },
    };
  }

  return {
    status: "waiting",
    currentStage: "asset_graph_pending",
    progress: 94,
    nextActionAt: new Date().toISOString(),
    enqueueReason: "human_approved_gameplay_asset_graph",
    state: {
      ...context.state,
      video_approvals: approvals.items,
      approved_video_generation_ids: approved.map((item) => item.generationId),
      approved_video_shot_ids: approved.map((item) => item.shotId),
      rejected_video_generation_ids: rejected.map((item) => item.generationId),
      video_approval_required: true,
      human_video_gate_passed: true,
      asset_graph_locked: false,
      assembly_locked: false,
    },
    stateReason: "s4_005d_human_video_gate_passed_asset_graph_ready",
    eventType: "discovery.gameplay_video_gate_passed",
    eventPayload: {
      approved_generation_ids: approved.map((item) => item.generationId),
      rejected_generation_ids: rejected.map((item) => item.generationId),
      human_video_gate_passed: true,
      ai_video_rejection_enabled: false,
    },
  };
}

async function handleVideoRevisionPending(context: WorkflowTickContext): Promise<WorkflowTickOutcome> {
  const rootCreativeRunId = text(context.state.creative_run_id);
  if (!rootCreativeRunId) {
    return failedOutcome({
      context,
      currentStage: "video_revision_pending",
      code: "DISCOVERY_VIDEO_ROOT_MISSING",
      message: "Gameplay video revision is missing the root creative run id",
      stateReason: "s4_005e_video_revision_root_missing",
      eventType: "discovery.gameplay_video_revision_failed",
    });
  }

  const services = runtime(context);
  let videoApprovals;
  let visual;
  let planning;
  let concepts;
  let feedback;
  try {
    [videoApprovals, visual, planning, concepts, feedback] = await Promise.all([
      services.video.getGameplayVideoApprovalStage({ rootCreativeRunId }),
      services.gameDiscovery.getVisualStage({ rootCreativeRunId }),
      services.gameDiscovery.getPlanningStage({ rootCreativeRunId }),
      services.gameDiscovery.getConceptStage({ rootCreativeRunId }),
      services.gameDiscovery.getFeedbackMemory({ rootCreativeRunId }),
    ]);
  } catch (error) {
    throw persistenceError("GAMEPLAY_VIDEO_REVISION_CONTEXT_LOAD_FAILED", error);
  }

  const revised = videoApprovals.items.filter((item) => item.decision === "revise");
  if (!revised.length) {
    return {
      status: "waiting",
      currentStage: "human_video_approval_pending",
      progress: 93,
      nextActionAt: null,
      enqueueReason: null,
      state: context.state,
      stateReason: "s4_005e_video_revision_no_longer_requested",
    };
  }

  const shotById = new Map(visual.shots.map((shot) => [shot.shotId, shot]));
  const momentById = new Map(planning.moments.map((moment) => [moment.momentId, moment]));
  const conceptById = new Map(concepts.acceptedConcepts.map((concept) => [concept.conceptId, concept]));
  const counts = revisionCounts(context.state);
  const admissions: Array<{
    shotId: string;
    sourceVideoGenerationId: string;
    generationId: string;
    factoryJobId: string;
    reviewId: string;
    revisionNumber: number;
  }> = [];

  for (const item of revised) {
    const reviewId = item.reviewId;
    if (!reviewId) {
      throw new DurableWorkflowError({
        code: "GAMEPLAY_VIDEO_REVISION_REVIEW_MISSING",
        message: `Human revise decision for ${item.shotId} has no review id`,
        retryable: false,
      });
    }
    const shot = shotById.get(item.shotId);
    const moment = momentById.get(item.momentId);
    const concept = conceptById.get(item.conceptId);
    if (!shot || !moment || !concept) {
      throw new DurableWorkflowError({
        code: "GAMEPLAY_VIDEO_REVISION_LINEAGE_MISSING",
        message: `Could not resolve persisted planning lineage for revised video ${item.shotId}`,
        retryable: false,
      });
    }

    const [promptPlan] = compileGameplayPromptPlans({
      concepts: [concept],
      moments: [moment],
      shots: [shot],
      feedbackMemory: feedback,
    });
    if (!promptPlan?.videoPrompt) {
      throw new DurableWorkflowError({
        code: "GAMEPLAY_VIDEO_REVISION_PROMPT_MISSING",
        message: `Could not compile a revised video prompt for ${item.shotId}`,
        retryable: false,
      });
    }

    const revisionNumber = (counts[item.shotId] ?? 0) + 1;
    const requestId = stableUuid(
      `stage4-video-revision:${context.jobId}:${item.shotId}:${item.generationId}:${reviewId}:r${revisionNumber}`,
    );
    try {
      const admission = await services.video.createApprovedVideo({
        rootJobId: context.jobId,
        rootCreativeRunId,
        requestId,
        referenceGenerationId: item.approvedReferenceGenerationId,
        shotId: item.shotId,
        videoPromptOverride: promptPlan.videoPrompt,
        sourceVideoGenerationId: item.generationId,
        revisionReviewId: reviewId,
        videoRevisionNumber: revisionNumber,
      });
      counts[item.shotId] = revisionNumber;
      admissions.push({
        shotId: item.shotId,
        sourceVideoGenerationId: item.generationId,
        generationId: admission.generationId,
        factoryJobId: admission.factoryJobId,
        reviewId,
        revisionNumber,
      });
    } catch (error) {
      throw persistenceError("HUMAN_GAMEPLAY_VIDEO_REVISION_ADMISSION_FAILED", error);
    }
  }

  return {
    status: "waiting",
    currentStage: "video_generation_waiting",
    progress: 91,
    nextActionAt: nextAt(VIDEO_POLL_MS),
    enqueueReason: "human_gameplay_video_revision_reconcile",
    state: {
      ...context.state,
      gameplay_video_revision_admissions: admissions,
      video_revision_numbers: counts,
      feedback_memory_applied: feedback,
      video_approval_required: true,
      human_video_gate_passed: false,
      asset_graph_locked: true,
      assembly_locked: true,
      video_generation_locked: false,
    },
    stateReason: "s4_005e_human_video_revision_admitted_feedback_applied",
    eventType: "discovery.gameplay_video_revision_admitted",
    eventPayload: {
      revised_shot_ids: admissions.map((item) => item.shotId),
      source_generation_ids: admissions.map((item) => item.sourceVideoGenerationId),
      new_generation_ids: admissions.map((item) => item.generationId),
      review_ids: admissions.map((item) => item.reviewId),
      revision_numbers: Object.fromEntries(admissions.map((item) => [item.shotId, item.revisionNumber])),
      feedback_rule_count: feedback.mustShow.length + feedback.mustAvoid.length + feedback.errorTags.length,
      automatic_video_regeneration: false,
      human_requested_regeneration: true,
    },
  };
}

async function handleAssetGraphPending(context: WorkflowTickContext): Promise<WorkflowTickOutcome> {
  const rootCreativeRunId = text(context.state.creative_run_id);
  if (!rootCreativeRunId) {
    return failedOutcome({
      context,
      currentStage: "asset_graph_pending",
      code: "DISCOVERY_ASSET_GRAPH_ROOT_MISSING",
      message: "Gameplay AssetGraph persistence is missing the root creative run id",
      stateReason: "s4_005c_asset_graph_root_missing",
      eventType: "discovery.asset_graph_failed",
    });
  }

  const services = runtime(context);
  let referenceApprovals;
  let videoApprovals;
  try {
    [referenceApprovals, videoApprovals] = await Promise.all([
      services.gameDiscovery.getReferenceApprovalStage({ rootCreativeRunId }),
      services.video.getGameplayVideoApprovalStage({ rootCreativeRunId }),
    ]);
  } catch (error) {
    throw persistenceError("GAMEPLAY_ASSET_GRAPH_RECONCILE_FAILED", error);
  }

  const approvedReferences = referenceApprovals.items.filter((item) => item.decision === "approve");
  const approvedVideos = videoApprovals.items.filter((item) => item.decision === "approve");
  if (!videoApprovals.allReviewed || !approvedVideos.length) {
    return failedOutcome({
      context,
      currentStage: "asset_graph_pending",
      code: "DISCOVERY_ASSET_GRAPH_INPUTS_INCOMPLETE",
      message: "AssetGraph requires at least one human-approved completed gameplay video",
      stateReason: "s4_005c_asset_graph_inputs_incomplete",
      eventType: "discovery.asset_graph_failed",
    });
  }

  const referencesByShot = new Map(approvedReferences.map((item) => [item.shotId, item]));
  const graphs = [];

  for (const video of approvedVideos) {
    const reference = referencesByShot.get(video.shotId);
    if (
      !reference ||
      video.status !== "completed" ||
      video.approvedReferenceGenerationId !== reference.generationId ||
      video.conceptRunId !== reference.conceptRunId ||
      video.conceptId !== reference.conceptId ||
      video.momentId !== reference.momentId
    ) {
      return failedOutcome({
        context,
        currentStage: "asset_graph_pending",
        code: "DISCOVERY_ASSET_GRAPH_LINEAGE_MISMATCH",
        message: `AssetGraph lineage mismatch for human-approved video ${video.shotId}`,
        stateReason: "s4_005c_asset_graph_lineage_mismatch",
        eventType: "discovery.asset_graph_failed",
        eventPayload: { shot_id: video.shotId, video_generation_id: video.generationId },
      });
    }

    const graph = buildGameplayAssetGraph({
      objectiveRunId: rootCreativeRunId,
      conceptRunId: video.conceptRunId,
      conceptId: video.conceptId,
      momentId: video.momentId,
      shotId: video.shotId,
      approvedReferenceGenerationId: reference.generationId,
      approvedReferenceOutputs: reference.outputs,
      videoGenerationId: video.generationId,
      videoOutputs: video.outputs,
    });

    try {
      await services.video.persistAssetGraph({
        rootJobId: context.jobId,
        rootCreativeRunId,
        conceptRunId: video.conceptRunId,
        assetGraph: graph,
      });
    } catch (error) {
      throw persistenceError("GAMEPLAY_ASSET_GRAPH_PERSIST_FAILED", error);
    }
    graphs.push(graph);
  }

  return {
    status: "waiting",
    currentStage: "assembly_pending",
    progress: 96,
    nextActionAt: null,
    state: {
      ...context.state,
      asset_graphs: graphs,
      asset_graphs_completed_at: new Date().toISOString(),
      video_generation_locked: false,
      video_approval_required: true,
      human_video_gate_passed: true,
      asset_graph_locked: false,
      assembly_locked: false,
    },
    stateReason: "s4_005c_human_approved_asset_graphs_ready_for_assembly",
    eventType: "discovery.asset_graphs_ready",
    eventPayload: {
      asset_graph_count: graphs.length,
      concept_run_ids: graphs.map((graph) => graph.conceptRunId),
      approved_video_generation_ids: approvedVideos.map((item) => item.generationId),
      next_stage: "assembly_pending",
    },
  };
}

export const gameDiscoveryBatchStage4VideoV1: WorkflowTickHandler = async (context) => {
  if (context.currentStage === "video_generation_pending") {
    return handleVideoPending(context);
  }
  if (context.currentStage === "video_generation_waiting") {
    return handleVideoWaiting(context);
  }
  if (context.currentStage === "human_video_approval_pending") {
    return handleHumanVideoApproval(context);
  }
  if (context.currentStage === "video_revision_pending") {
    return handleVideoRevisionPending(context);
  }
  if (context.currentStage === "asset_graph_pending") {
    return handleAssetGraphPending(context);
  }

  const outcome = await gameDiscoveryBatchStage4V1(context);
  if (outcome.status === "waiting" && outcome.currentStage === "video_generation_pending") {
    return {
      ...outcome,
      nextActionAt: new Date().toISOString(),
      enqueueReason: "approved_gameplay_video_admission",
    };
  }
  return outcome;
};
