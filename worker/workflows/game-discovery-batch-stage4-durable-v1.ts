import { gameDiscoveryBatchStage4AssemblyV1 } from "./game-discovery-batch-stage4-assembly-v1";
import type { WorkflowTickHandler, WorkflowTickOutcome } from "./types";

/**
 * Preserve intentionally parked waiting states (notably human reference approval),
 * while making internal Stage 4 hand-offs self-waking. Gameplay moment planning
 * persists its checkpoint before returning shot_planning_pending, so the next tick
 * can safely be enqueued immediately without repeating the LLM work.
 */
export function enforceStage4DurableWakeup(outcome: WorkflowTickOutcome): WorkflowTickOutcome {
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
