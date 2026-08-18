import { createHash } from "node:crypto";
import { buildGameplayAssetGraph } from "../../lib/game-discovery/asset-graph";
import { DurableWorkflowError } from "../../lib/orchestrator/retry";
import { gameDiscoveryBatchStage4V1 } from "./game-discovery-batch-stage4-v1";
import type { WorkflowTickContext, WorkflowTickHandler, WorkflowTickOutcome } from "./types";

const VIDEO_POLL_MS = 5_000;

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
    },
    stateReason: "s4_005b_approved_gameplay_videos_admitted",
    eventType: "discovery.gameplay_videos_admitted",
    eventPayload: {
      admitted_count: admissions.length,
      existing_count: videoStage.items.length,
      expected_count: approved.length,
      approved_reference_generation_ids: approved.map((item) => item.generationId),
      human_reference_gate_passed: true,
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
    currentStage: "asset_graph_pending",
    progress: 94,
    nextActionAt: new Date().toISOString(),
    enqueueReason: "gameplay_asset_graph_persist",
    state: {
      ...context.state,
      gameplay_videos: videoStage.items,
      gameplay_videos_completed_at: new Date().toISOString(),
      video_generation_locked: false,
    },
    stateReason: "s4_005b_approved_gameplay_videos_ready_for_asset_graph",
    eventType: "discovery.gameplay_videos_ready",
    eventPayload: {
      video_count: videoStage.items.length,
      generation_ids: videoStage.items.map((item) => item.generationId),
      next_stage: "asset_graph_pending",
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
  let approvals;
  let videoStage;
  try {
    [approvals, videoStage] = await Promise.all([
      services.gameDiscovery.getReferenceApprovalStage({ rootCreativeRunId }),
      services.video.getGameplayVideoStage({ rootCreativeRunId }),
    ]);
  } catch (error) {
    throw persistenceError("GAMEPLAY_ASSET_GRAPH_RECONCILE_FAILED", error);
  }

  const approved = approvals.items.filter((item) => item.decision === "approve");
  if (!approved.length || !videoStage.allCompleted) {
    return failedOutcome({
      context,
      currentStage: "asset_graph_pending",
      code: "DISCOVERY_ASSET_GRAPH_INPUTS_INCOMPLETE",
      message: "AssetGraph requires at least one current approved reference and completed gameplay video",
      stateReason: "s4_005c_asset_graph_inputs_incomplete",
      eventType: "discovery.asset_graph_failed",
    });
  }

  const videosByShot = new Map(videoStage.items.map((item) => [item.shotId, item]));
  const graphs = [];

  for (const reference of approved) {
    const video = videosByShot.get(reference.shotId);
    if (
      !video ||
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
        message: `AssetGraph lineage mismatch for shot ${reference.shotId}`,
        stateReason: "s4_005c_asset_graph_lineage_mismatch",
        eventType: "discovery.asset_graph_failed",
        eventPayload: { shot_id: reference.shotId },
      });
    }

    const graph = buildGameplayAssetGraph({
      objectiveRunId: rootCreativeRunId,
      conceptRunId: reference.conceptRunId,
      conceptId: reference.conceptId,
      momentId: reference.momentId,
      shotId: reference.shotId,
      approvedReferenceGenerationId: reference.generationId,
      approvedReferenceOutputs: reference.outputs,
      videoGenerationId: video.generationId,
      videoOutputs: video.outputs,
    });

    try {
      await services.video.persistAssetGraph({
        rootJobId: context.jobId,
        rootCreativeRunId,
        conceptRunId: reference.conceptRunId,
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
    },
    stateReason: "s4_005c_asset_graphs_ready_for_assembly",
    eventType: "discovery.asset_graphs_ready",
    eventPayload: {
      asset_graph_count: graphs.length,
      concept_run_ids: graphs.map((graph) => graph.conceptRunId),
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
