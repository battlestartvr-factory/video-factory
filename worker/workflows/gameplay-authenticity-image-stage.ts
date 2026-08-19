import { gameplayAuthenticitySpecFromShot } from "../../lib/game-discovery/gameplay-authenticity";
import {
  gameplayAuthenticityFeedbackFromImageInspection,
  type GameplayImageAuthenticityInspectionV1,
} from "../../lib/game-discovery/gameplay-authenticity-inspection";
import type { DiscoveryFeedbackMemory } from "../../lib/game-discovery/shot-planner";
import { mergeDiscoveryFeedback } from "./gameplay-authenticity-auto-feedback";
import {
  inspectGameplayImageFromWorker,
  outputDriveFileId,
} from "./gameplay-authenticity-inspection-client";
import type { WorkflowTickContext, WorkflowTickOutcome } from "./types";

export const MAX_AUTOMATIC_IMAGE_AUTHENTICITY_REVISIONS_PER_SHOT = 1;

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
    Object.entries(object(state.gameplay_authenticity_auto_revision_counts)).map(([key, value]) => [
      key,
      typeof value === "number" ? Math.max(0, Math.trunc(value)) : 0,
    ]),
  );
}

export async function inspectReferenceImagesBeforeHumanGate(input: {
  context: WorkflowTickContext;
  baseOutcome: WorkflowTickOutcome;
}): Promise<WorkflowTickOutcome> {
  const { context, baseOutcome } = input;
  const rootCreativeRunId = text(context.state.creative_run_id);
  const repository = context.services?.gameDiscovery;
  if (!rootCreativeRunId || !repository) return baseOutcome;

  const [visual, referenceStage] = await Promise.all([
    repository.getVisualStage({ rootCreativeRunId }),
    repository.getReferenceImageStage({ rootCreativeRunId }),
  ]);
  const shotById = new Map(visual.shots.map((shot) => [shot.shotId, shot]));
  const inspections: GameplayImageAuthenticityInspectionV1[] = [];
  const inconclusive: Array<{ shotId: string; generationId: string; error: string }> = [];

  for (const item of referenceStage.items.filter((candidate) => candidate.status === "completed")) {
    const shot = shotById.get(item.shotId);
    const driveFileId = outputDriveFileId(item.outputs);
    if (!shot || !driveFileId) {
      inconclusive.push({
        shotId: item.shotId,
        generationId: item.generationId,
        error: !shot ? "planned_shot_missing" : "drive_output_missing",
      });
      continue;
    }

    try {
      inspections.push(
        await inspectGameplayImageFromWorker({
          rootCreativeRunId,
          generationId: item.generationId,
          shotId: item.shotId,
          conceptId: item.conceptId,
          momentId: item.momentId,
          driveFileId,
          plannedAuthenticity: gameplayAuthenticitySpecFromShot(shot),
          signal: context.signal,
        }),
      );
    } catch (error) {
      inconclusive.push({
        shotId: item.shotId,
        generationId: item.generationId,
        error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
      });
    }
  }

  const failed = inspections.filter((inspection) => !inspection.passed);
  if (!failed.length && !inconclusive.length) {
    return {
      ...baseOutcome,
      state: {
        ...(baseOutcome.state ?? context.state),
        gameplay_image_authenticity_inspections: inspections,
        gameplay_image_authenticity_gate_passed: true,
      },
      stateReason: "s4_generated_reference_images_passed_authenticity_inspection",
      eventType: "discovery.reference_images_authenticity_passed",
      eventPayload: {
        inspected_count: inspections.length,
        generation_ids: inspections.map((inspection) => inspection.generationId),
        human_gate_next: true,
      },
    };
  }

  const counts = revisionCounts(context.state);
  const mayAutoRevise =
    inconclusive.length === 0 &&
    failed.length > 0 &&
    failed.every(
      (inspection) =>
        (counts[inspection.shotId] ?? 0) < MAX_AUTOMATIC_IMAGE_AUTHENTICITY_REVISIONS_PER_SHOT,
    );

  if (mayAutoRevise) {
    const feedback = failed
      .map(gameplayAuthenticityFeedbackFromImageInspection)
      .reduce<DiscoveryFeedbackMemory>(
        (merged, item) => mergeDiscoveryFeedback(merged, item),
        { mustShow: [], mustAvoid: [], errorTags: [] },
      );
    const nextCounts = { ...counts };
    failed.forEach((inspection) => {
      nextCounts[inspection.shotId] = (nextCounts[inspection.shotId] ?? 0) + 1;
    });
    const byGeneration = new Map(failed.map((inspection) => [inspection.generationId, inspection]));
    const syntheticApprovals = referenceStage.items
      .filter((item) => byGeneration.has(item.generationId))
      .map((item) => ({
        shotId: item.shotId,
        generationId: item.generationId,
        reviewId: `auto-gameplay-authenticity:${item.generationId}`,
        decision: "revise",
        rawFeedback:
          "Automatic gameplay-authenticity inspection rejected this generated reference before human review.",
        structuredFeedback: gameplayAuthenticityFeedbackFromImageInspection(
          byGeneration.get(item.generationId)!,
        ),
      }));

    return {
      status: "waiting",
      currentStage: "reference_revision_pending",
      progress: 84,
      nextActionAt: new Date().toISOString(),
      enqueueReason: "automatic_gameplay_authenticity_revision",
      state: {
        ...(baseOutcome.state ?? context.state),
        gameplay_authenticity_failure: true,
        gameplay_authenticity_failure_stage: "post_image",
        gameplay_image_authenticity_inspections: inspections,
        gameplay_authenticity_auto_feedback_memory: feedback,
        gameplay_authenticity_auto_revision_counts: nextCounts,
        reference_approvals: syntheticApprovals,
        revision_shot_ids: failed.map((inspection) => inspection.shotId),
        reference_approval_required: true,
        video_generation_locked: true,
        regeneration_caused_by_authenticity_failure: true,
      },
      stateReason: "s4_generated_reference_failed_authenticity_auto_revision",
      eventType: "discovery.reference_image_authenticity_revision_requested",
      eventPayload: {
        failed_shot_ids: failed.map((inspection) => inspection.shotId),
        hard_failures: Object.fromEntries(
          failed.map((inspection) => [inspection.shotId, inspection.hardFailures]),
        ),
        automatic_revision_limit_per_shot: MAX_AUTOMATIC_IMAGE_AUTHENTICITY_REVISIONS_PER_SHOT,
        human_gate_skipped_for_bad_reference: true,
      },
    };
  }

  const defectReport = {
    failed: failed.map((inspection) => ({
      shotId: inspection.shotId,
      generationId: inspection.generationId,
      averageScore: inspection.averageScore,
      hardFailures: inspection.hardFailures,
      modelDefects: inspection.observation.defects,
    })),
    inconclusive,
    automaticRevisionLimitPerShot: MAX_AUTOMATIC_IMAGE_AUTHENTICITY_REVISIONS_PER_SHOT,
    automaticRevisionCounts: counts,
  };

  return {
    ...baseOutcome,
    state: {
      ...(baseOutcome.state ?? context.state),
      gameplay_authenticity_failure: true,
      gameplay_authenticity_failure_stage: "post_image",
      gameplay_image_authenticity_inspections: inspections,
      gameplay_image_authenticity_inconclusive: inconclusive,
      gameplay_authenticity_defect_report: defectReport,
      automatic_authenticity_revision_limit_reached: true,
      video_generation_locked: true,
    },
    stateReason: "s4_generated_reference_authenticity_human_gate_with_defect_report",
    eventType: "discovery.reference_image_authenticity_human_review_required",
    eventPayload: {
      defect_report: defectReport,
      human_gate_next: true,
      no_more_automatic_regeneration: true,
    },
  };
}
