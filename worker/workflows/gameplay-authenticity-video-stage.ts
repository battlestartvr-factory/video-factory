import { gameplayAuthenticitySpecFromShot } from "../../lib/game-discovery/gameplay-authenticity";
import type { GameplayVideoAuthenticityInspectionV1 } from "../../lib/game-discovery/gameplay-authenticity-inspection";
import {
  inspectGameplayVideoFromWorker,
  resolveInspectionDriveFileId,
} from "./gameplay-authenticity-inspection-client";
import type { WorkflowTickContext, WorkflowTickOutcome } from "./types";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function inspectGameplayVideosBeforeAssetGraph(input: {
  context: WorkflowTickContext;
  baseOutcome: WorkflowTickOutcome;
}): Promise<WorkflowTickOutcome> {
  const { context, baseOutcome } = input;
  const rootCreativeRunId = text(context.state.creative_run_id);
  const services = context.services;
  if (!rootCreativeRunId || !services?.gameDiscovery || !services.gameDiscoveryVideo) {
    return baseOutcome;
  }

  const [visual, videoStage] = await Promise.all([
    services.gameDiscovery.getVisualStage({ rootCreativeRunId }),
    services.gameDiscoveryVideo.getGameplayVideoStage({ rootCreativeRunId }),
  ]);
  const shotById = new Map(visual.shots.map((shot) => [shot.shotId, shot]));
  const inspections: GameplayVideoAuthenticityInspectionV1[] = [];
  const failures: Array<{ shotId: string; generationId: string; error: string }> = [];

  for (const item of videoStage.items.filter((candidate) => candidate.status === "completed")) {
    const shot = shotById.get(item.shotId);
    if (!shot) {
      failures.push({
        shotId: item.shotId,
        generationId: item.generationId,
        error: "planned_shot_missing",
      });
      continue;
    }

    try {
      const driveFileId = await resolveInspectionDriveFileId({
        rootCreativeRunId,
        generationId: item.generationId,
        shotId: item.shotId,
        assetType: "video",
        outputs: item.outputs,
        signal: context.signal,
      });
      const inspection = await inspectGameplayVideoFromWorker({
        rootCreativeRunId,
        generationId: item.generationId,
        shotId: item.shotId,
        conceptId: item.conceptId,
        momentId: item.momentId,
        driveFileId,
        plannedAuthenticity: gameplayAuthenticitySpecFromShot(shot),
        signal: context.signal,
      });
      inspections.push(inspection);
      if (!inspection.passed) {
        failures.push({
          shotId: item.shotId,
          generationId: item.generationId,
          error: inspection.hardFailures.join(",") || `score:${inspection.averageScore}`,
        });
      }
    } catch (error) {
      failures.push({
        shotId: item.shotId,
        generationId: item.generationId,
        error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
      });
    }
  }

  if (failures.length) {
    return {
      status: "failed",
      currentStage: "gameplay_video_authenticity_failed",
      progress: 93,
      state: {
        ...context.state,
        gameplay_video_authenticity_inspections: inspections,
        gameplay_video_authenticity_failures: failures,
        gameplay_authenticity_failure: true,
        gameplay_authenticity_failure_stage: "post_video",
        asset_graph_locked: true,
        assembly_locked: true,
        video_generation_locked: true,
        automatic_video_regeneration: false,
      },
      error: {
        code: "GAMEPLAY_VIDEO_AUTHENTICITY_INSPECTION_FAILED",
        message: failures.map((item) => `${item.shotId}:${item.error}`).join(" | ").slice(0, 2_000),
        retryable: false,
      },
      stateReason: "s4_generated_video_failed_authenticity_before_asset_graph",
      eventType: "discovery.gameplay_video_authenticity_failed",
      eventPayload: {
        failures,
        assembly_blocked: true,
        automatic_video_regeneration: false,
      },
    };
  }

  return {
    ...baseOutcome,
    state: {
      ...(baseOutcome.state ?? context.state),
      gameplay_video_authenticity_inspections: inspections,
      gameplay_video_authenticity_inspection_passed: true,
    },
    stateReason: "s4_generated_videos_passed_authenticity_before_asset_graph",
    eventType: "discovery.gameplay_video_authenticity_passed",
    eventPayload: {
      inspected_count: inspections.length,
      generation_ids: inspections.map((inspection) => inspection.generationId),
      asset_graph_next: true,
    },
  };
}
