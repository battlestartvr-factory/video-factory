import { DurableWorkflowError } from "../../lib/orchestrator/retry";
import type { WorkflowTickHandler } from "./types";

export const coreSmokeV1: WorkflowTickHandler = (context) => {
  if (context.signal.aborted) {
    throw new Error("core_smoke tick aborted");
  }

  const rawStep = context.state.smoke_step;
  const step = typeof rawStep === "number" ? rawStep : 0;

  if (step === 0 && context.state.simulate_terminal_failure === true) {
    throw new DurableWorkflowError({
      code: "CORE_SMOKE_TERMINAL",
      message: "Injected terminal core-smoke failure",
      retryable: false,
    });
  }

  if (
    step === 0 &&
    context.state.simulate_retry_once === true &&
    context.retryCount === 0
  ) {
    throw new DurableWorkflowError({
      code: "CORE_SMOKE_TRANSIENT",
      message: "Injected transient core-smoke failure",
      retryable: true,
      retryAfterMs: 1_000,
    });
  }

  if (step === 0) {
    return {
      status: "queued",
      state: {
        ...context.state,
        smoke_step: 1,
        checkpoint_a_at: new Date().toISOString(),
      },
      currentStage: "checkpoint_a",
      progress: 50,
      stateReason: "core_smoke_checkpoint_a",
      eventType: "stage.succeeded",
      eventPayload: { stage: "checkpoint_a", smoke_step: 1 },
      enqueueReason: "next_stage",
    };
  }

  if (step === 1) {
    const completedAt = new Date().toISOString();
    return {
      status: "completed",
      state: {
        ...context.state,
        smoke_step: 2,
        completed_at: completedAt,
      },
      currentStage: "complete",
      progress: 100,
      result: {
        ok: true,
        workflow: "core_smoke@1",
        completed_at: completedAt,
      },
      stateReason: "core_smoke_completed",
      eventType: "job.completed",
      eventPayload: { smoke_step: 2 },
    };
  }

  return {
    status: "failed",
    state: context.state,
    currentStage: context.currentStage,
    error: {
      code: "CORE_SMOKE_INVALID_STATE",
      message: `Unexpected smoke_step: ${String(rawStep)}`,
    },
    stateReason: "core_smoke_invalid_state",
    eventType: "job.failed",
  };
};
