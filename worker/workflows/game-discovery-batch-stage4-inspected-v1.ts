import { gameDiscoveryBatchStage4ReferenceIntegratedV1 } from "./game-discovery-batch-stage4-reference-integrated-v1";
import type { WorkflowTickHandler } from "./types";

/**
 * Stage 4 keeps generated media admission strictly human-controlled.
 *
 * Generated reference images and gameplay videos are never inspected, rejected,
 * revised, regenerated, or blocked by an AI evaluator after generation. The workflow
 * parks at explicit human gates where a person can approve, reject, or request a
 * revision. Human-requested revisions may be repeated without an application-level
 * retry cap, and written feedback is persisted as factory memory for later planning.
 *
 * Planning-time gameplay contracts remain available to shape prompts before provider
 * calls, but they are not allowed to overrule the person's decision on generated media.
 */
export const gameDiscoveryBatchStage4InspectedV1: WorkflowTickHandler = async (context) =>
  gameDiscoveryBatchStage4ReferenceIntegratedV1(context);
