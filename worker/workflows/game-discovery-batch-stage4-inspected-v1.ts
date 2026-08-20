import { inspectGameplayVideosBeforeAssetGraph } from "./gameplay-authenticity-video-stage";
import { gameDiscoveryBatchStage4ReferenceIntegratedV1 } from "./game-discovery-batch-stage4-reference-integrated-v1";
import type { WorkflowTickHandler } from "./types";

/**
 * Stage 4 keeps generated reference-image admission strictly human-controlled.
 *
 * Generated reference images are never inspected, rejected, revised, or regenerated
 * by an AI evaluator here. Once image generation completes, the canonical Stage 4
 * workflow parks at human_reference_approval_pending until a person approves,
 * rejects, or requests a revision. Human-requested revisions may be repeated without
 * an application-level retry cap.
 *
 * Video authenticity inspection remains enabled before asset-graph admission.
 */
export const gameDiscoveryBatchStage4InspectedV1: WorkflowTickHandler = async (context) => {
  const outcome = await gameDiscoveryBatchStage4ReferenceIntegratedV1(context);

  if (
    context.currentStage === "video_generation_waiting" &&
    outcome.status === "waiting" &&
    outcome.currentStage === "asset_graph_pending"
  ) {
    return inspectGameplayVideosBeforeAssetGraph({ context, baseOutcome: outcome });
  }

  return outcome;
};
