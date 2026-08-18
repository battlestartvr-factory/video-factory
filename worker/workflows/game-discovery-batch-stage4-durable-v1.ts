import { gameDiscoveryBatchStage4AssemblyV1 } from "./game-discovery-batch-stage4-assembly-v1";
import type { WorkflowTickHandler, WorkflowTickOutcome } from "./types";

function reviewSetComplete(state: Record<string, unknown> | undefined): boolean {
  const approvals = state?.reference_approvals;
  if (!Array.isArray(approvals) || approvals.length === 0) return false;
  return approvals.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const decision = (item as Record<string, unknown>).decision;
    return decision === "approve" || decision === "reject" || decision === "revise";
  });
}

/**
 * Preserve intentionally parked waiting states (notably human reference approval),
 * while making internal Stage 4 hand-offs self-waking. Gameplay moment planning
 * persists its checkpoint before returning shot_planning_pending, so the next tick
 * can safely be enqueued immediately without repeating the LLM work.
 *
 * A partial set of human decisions must also stay parked. One Revise must not move
 * the workflow away from the gate while other reference cards are still undecided.
 */
export function enforceStage4DurableWakeup(outcome: WorkflowTickOutcome): WorkflowTickOutcome {
  if (
    outcome.status === "waiting" &&
    outcome.currentStage === "reference_revision_pending" &&
    !reviewSetComplete(outcome.state)
  ) {
    const { revision_shot_ids: _revisionShotIds, ...parkedState } = outcome.state ?? {};
    return {
      ...outcome,
      currentStage: "human_reference_approval_pending",
      progress: 85,
      nextActionAt: null,
      enqueueReason: null,
      state: parkedState,
      stateReason: "s4_005_waiting_for_all_human_reference_reviews",
      eventType: "discovery.reference_reviews_partial",
    };
  }

  if (
    outcome.status === "waiting" &&
    outcome.currentStage === "shot_planning_pending" &&
    outcome.nextActionAt == null
  ) {
    return {
      ...outcome,
      nextActionAt: new Date().toISOString(),
      enqueueReason: "shot_planning",
    };
  }

  return outcome;
}

export const gameDiscoveryBatchStage4DurableV1: WorkflowTickHandler = async (context) =>
  enforceStage4DurableWakeup(await gameDiscoveryBatchStage4AssemblyV1(context));
