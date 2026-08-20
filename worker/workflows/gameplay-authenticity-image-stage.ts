import type { WorkflowTickContext, WorkflowTickOutcome } from "./types";

/**
 * Automatic AI admission/rejection of generated reference images is intentionally disabled.
 * Generated images must always reach the human reference-approval gate unchanged.
 * A person may approve the image or request another revision/regeneration, repeatedly.
 */
export const MAX_AUTOMATIC_IMAGE_AUTHENTICITY_REVISIONS_PER_SHOT = 0;

/**
 * Compatibility passthrough for older callers.
 *
 * Do not add model inspection, automatic rejection, synthetic reviews, prompt mutation,
 * or automatic regeneration here. Reference-image quality decisions belong to the human.
 */
export async function inspectReferenceImagesBeforeHumanGate(input: {
  context: WorkflowTickContext;
  baseOutcome: WorkflowTickOutcome;
}): Promise<WorkflowTickOutcome> {
  return input.baseOutcome;
}
