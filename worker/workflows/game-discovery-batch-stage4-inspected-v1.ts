import { contextWithAutomaticGameplayFeedback } from "./gameplay-authenticity-auto-feedback";
import { inspectReferenceImagesBeforeHumanGate } from "./gameplay-authenticity-image-stage";
import { inspectGameplayVideosBeforeAssetGraph } from "./gameplay-authenticity-video-stage";
import { gameDiscoveryBatchStage4ReferenceIntegratedV1 } from "./game-discovery-batch-stage4-reference-integrated-v1";
import type { WorkflowTickHandler } from "./types";

export const gameDiscoveryBatchStage4InspectedV1: WorkflowTickHandler = async (rawContext) => {
  const context = contextWithAutomaticGameplayFeedback(rawContext);
  const outcome = await gameDiscoveryBatchStage4ReferenceIntegratedV1(context);

  if (
    rawContext.currentStage === "reference_image_waiting" &&
    outcome.status === "waiting" &&
    outcome.currentStage === "human_reference_approval_pending"
  ) {
    return inspectReferenceImagesBeforeHumanGate({ context, baseOutcome: outcome });
  }

  if (
    rawContext.currentStage === "video_generation_waiting" &&
    outcome.status === "waiting" &&
    outcome.currentStage === "asset_graph_pending"
  ) {
    return inspectGameplayVideosBeforeAssetGraph({ context, baseOutcome: outcome });
  }

  return outcome;
};
