import {
  attachGameplayPrototypeShort,
  buildGameplayAssetGraph,
} from "../../lib/game-discovery/asset-graph";
import {
  GameDiscoveryAssemblyService,
  type GameDiscoveryAssemblyRuntime,
} from "../../lib/game-discovery/assembly";
import { DurableWorkflowError } from "../../lib/orchestrator/retry";
import { gameDiscoveryBatchStage4VideoV1 } from "./game-discovery-batch-stage4-video-v1";
import type { WorkflowTickContext, WorkflowTickHandler, WorkflowTickOutcome } from "./types";

let defaultAssemblyRuntime: GameDiscoveryAssemblyRuntime | null | undefined;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

function assemblyRuntimeFromEnv(): GameDiscoveryAssemblyRuntime {
  if (defaultAssemblyRuntime) return defaultAssemblyRuntime;
  const token = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? "").trim();
  if (!token) {
    throw new DurableWorkflowError({
      code: "DISCOVERY_ASSEMBLY_SERVICE_TOKEN_MISSING",
      message: "Stage 4 assembly requires a service-role token for internal media/archive routes",
      retryable: false,
    });
  }
  const baseUrl = (process.env.WORKER_APP_INTERNAL_URL ?? "http://app:3000").trim() || "http://app:3000";
  defaultAssemblyRuntime = new GameDiscoveryAssemblyService(baseUrl, token);
  return defaultAssemblyRuntime;
}

function runtime(context: WorkflowTickContext) {
  const gameDiscovery = context.services?.gameDiscovery;
  const video = context.services?.gameDiscoveryVideo;
  const assembly = context.services?.gameDiscoveryAssembly ?? assemblyRuntimeFromEnv();
  if (!gameDiscovery || !video) {
    throw new DurableWorkflowError({
      code: "DISCOVERY_ASSEMBLY_REPOSITORY_MISSING",
      message: "Stage 4 assembly repositories are not configured",
      retryable: false,
    });
  }
  return { gameDiscovery, video, assembly };
}

function failedOutcome(input: {
  context: WorkflowTickContext;
  stage: string;
  code: string;
  message: string;
  reason: string;
  eventType: string;
  payload?: Record<string, unknown>;
}): WorkflowTickOutcome {
  return {
    status: "failed",
    currentStage: input.stage,
    progress: 97,
    state: input.context.state,
    error: { code: input.code, message: input.message, retryable: false },
    stateReason: input.reason,
    eventType: input.eventType,
    eventPayload: input.payload,
  };
}

async function handleAssemblyPending(context: WorkflowTickContext): Promise<WorkflowTickOutcome> {
  const rootCreativeRunId = text(context.state.creative_run_id);
  if (!rootCreativeRunId) {
    return failedOutcome({
      context,
      stage: "assembly_pending",
      code: "DISCOVERY_ASSEMBLY_ROOT_MISSING",
      message: "Prototype assembly is missing the root creative run id",
      reason: "s4_006_assembly_root_missing",
      eventType: "discovery.prototype_assembly_failed",
    });
  }

  const services = runtime(context);
  let approvals;
  let videoStage;
  let assemblyStage;
  try {
    [approvals, videoStage, assemblyStage] = await Promise.all([
      services.gameDiscovery.getReferenceApprovalStage({ rootCreativeRunId }),
      services.video.getGameplayVideoStage({ rootCreativeRunId }),
      services.video.getAssemblyStage({ rootCreativeRunId }),
    ]);
  } catch (error) {
    throw persistenceError("GAMEPLAY_ASSEMBLY_RECONCILE_FAILED", error);
  }

  const approved = approvals.items.filter((item) => item.decision === "approve");
  if (!approved.length || !videoStage.allCompleted) {
    return failedOutcome({
      context,
      stage: "assembly_pending",
      code: "DISCOVERY_ASSEMBLY_INPUTS_INCOMPLETE",
      message: "Prototype assembly requires current approved references and completed gameplay videos",
      reason: "s4_006_assembly_inputs_incomplete",
      eventType: "discovery.prototype_assembly_failed",
    });
  }

  const conceptCounts = new Map<string, number>();
  for (const item of approved) {
    conceptCounts.set(item.conceptRunId, (conceptCounts.get(item.conceptRunId) ?? 0) + 1);
  }
  const multiShot = [...conceptCounts.entries()].find(([, count]) => count > 1);
  if (multiShot) {
    return failedOutcome({
      context,
      stage: "assembly_pending",
      code: "DISCOVERY_ASSEMBLY_MULTISHOT_NOT_SUPPORTED_V1",
      message: `Stage 4 v1 expects one evidence shot per concept; ${multiShot[0]} has ${multiShot[1]}`,
      reason: "s4_006_multishot_contract_violation",
      eventType: "discovery.prototype_assembly_failed",
    });
  }

  const videosByShot = new Map(videoStage.items.map((item) => [item.shotId, item]));
  const existingByConcept = new Map(assemblyStage.items.map((item) => [item.conceptRunId, item]));
  const artifacts = [];
  const newlyAssembledConceptIds: string[] = [];

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
        stage: "assembly_pending",
        code: "DISCOVERY_ASSEMBLY_LINEAGE_MISMATCH",
        message: `Prototype assembly lineage mismatch for shot ${reference.shotId}`,
        reason: "s4_006_assembly_lineage_mismatch",
        eventType: "discovery.prototype_assembly_failed",
        payload: { shot_id: reference.shotId },
      });
    }

    const existing = existingByConcept.get(reference.conceptRunId);
    if (existing) {
      if (
        existing.conceptId !== reference.conceptId ||
        existing.inputVideoGenerationIds.length !== 1 ||
        existing.inputVideoGenerationIds[0] !== video.generationId
      ) {
        return failedOutcome({
          context,
          stage: "assembly_pending",
          code: "DISCOVERY_ASSEMBLY_STALE_VIDEO",
          message: `Persisted prototype for ${reference.conceptId} is tied to a stale gameplay video`,
          reason: "s4_006_stale_assembly_detected",
          eventType: "discovery.prototype_assembly_failed",
          payload: {
            concept_id: reference.conceptId,
            current_video_generation_id: video.generationId,
            assembly_video_generation_ids: existing.inputVideoGenerationIds,
          },
        });
      }
      artifacts.push(existing);
      continue;
    }

    let assembly;
    try {
      assembly = await services.assembly.assembleConceptPrototype({
        rootCreativeRunId,
        conceptRunId: reference.conceptRunId,
        conceptId: reference.conceptId,
        videoGenerationIds: [video.generationId],
        signal: context.signal,
      });
    } catch (error) {
      throw persistenceError("GAMEPLAY_FFMPEG_ASSEMBLY_FAILED", error);
    }

    const baseGraph = buildGameplayAssetGraph({
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
    const assembledGraph = attachGameplayPrototypeShort({ assetGraph: baseGraph, assembly });

    try {
      await services.video.persistAssembly({
        rootJobId: context.jobId,
        rootCreativeRunId,
        conceptRunId: reference.conceptRunId,
        assembly,
        assetGraph: assembledGraph,
      });
    } catch (error) {
      throw persistenceError("GAMEPLAY_ASSEMBLY_PERSIST_FAILED", error);
    }

    artifacts.push(assembly);
    newlyAssembledConceptIds.push(reference.conceptId);
  }

  return {
    status: "waiting",
    currentStage: "prototype_finalization_pending",
    progress: 99,
    nextActionAt: new Date().toISOString(),
    enqueueReason: "gameplay_prototype_finalize",
    state: {
      ...context.state,
      prototype_assemblies: artifacts,
      prototype_assemblies_completed_at: new Date().toISOString(),
    },
    stateReason: "s4_006_prototype_assemblies_ready",
    eventType: "discovery.prototype_assemblies_ready",
    eventPayload: {
      prototype_count: artifacts.length,
      newly_assembled_concept_ids: newlyAssembledConceptIds,
      reused_count: artifacts.length - newlyAssembledConceptIds.length,
      next_stage: "prototype_finalization_pending",
    },
  };
}

async function handleFinalizationPending(context: WorkflowTickContext): Promise<WorkflowTickOutcome> {
  const rootCreativeRunId = text(context.state.creative_run_id);
  if (!rootCreativeRunId) {
    return failedOutcome({
      context,
      stage: "prototype_finalization_pending",
      code: "DISCOVERY_FINALIZATION_ROOT_MISSING",
      message: "Prototype finalization is missing the root creative run id",
      reason: "s4_006_finalization_root_missing",
      eventType: "discovery.prototype_finalization_failed",
    });
  }

  const services = runtime(context);
  let result;
  try {
    result = await services.video.finalizeDiscoveryBatch({
      rootJobId: context.jobId,
      rootCreativeRunId,
    });
  } catch (error) {
    throw persistenceError("GAMEPLAY_DISCOVERY_FINALIZATION_FAILED", error);
  }

  return {
    status: "completed",
    currentStage: "completed",
    progress: 100,
    state: {
      ...context.state,
      prototype_result: result,
      completed_at: new Date().toISOString(),
    },
    result,
    stateReason: "s4_006_game_discovery_prototypes_completed",
    eventType: "discovery.completed",
    eventPayload: {
      prototype_count: typeof result.prototypeCount === "number" ? result.prototypeCount : null,
    },
  };
}

export const gameDiscoveryBatchStage4AssemblyV1: WorkflowTickHandler = async (context) => {
  if (context.currentStage === "assembly_pending") return handleAssemblyPending(context);
  if (context.currentStage === "prototype_finalization_pending") return handleFinalizationPending(context);

  const outcome = await gameDiscoveryBatchStage4VideoV1(context);
  if (outcome.status === "waiting" && outcome.currentStage === "assembly_pending") {
    return {
      ...outcome,
      nextActionAt: new Date().toISOString(),
      enqueueReason: "gameplay_prototype_assembly",
    };
  }
  return outcome;
};
