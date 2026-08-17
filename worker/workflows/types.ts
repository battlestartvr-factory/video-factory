export type DurableTickStatus =
  | "queued"
  | "waiting"
  | "retrying"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowTickContext {
  jobId: string;
  workflowKind: string;
  workflowVersion: number;
  currentStage: string | null;
  state: Record<string, unknown>;
  retryCount: number;
  signal: AbortSignal;
}

export interface WorkflowTickOutcome {
  status: DurableTickStatus;
  state?: Record<string, unknown>;
  currentStage?: string | null;
  progress?: number;
  nextActionAt?: string | null;
  result?: Record<string, unknown>;
  error?: Record<string, unknown> | null;
  stateReason?: string | null;
  eventType?: string;
  eventPayload?: Record<string, unknown>;
  enqueueReason?: string | null;
}

export type WorkflowTickHandler = (
  context: WorkflowTickContext,
) => Promise<WorkflowTickOutcome> | WorkflowTickOutcome;
