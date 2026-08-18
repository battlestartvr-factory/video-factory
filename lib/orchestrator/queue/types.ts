export const CORE_ORCHESTRATOR_QUEUE = "core_orchestrator_v1" as const;

export type OrchestratorQueueReason =
  | "created"
  | "next_stage"
  | "retry"
  | "callback"
  | "reconcile"
  | "manual"
  | string;

export interface OrchestratorQueueMessage {
  v: 1;
  job_id: string;
  reason: OrchestratorQueueReason;
  trace_id: string;
}

export interface QueueDelivery {
  msgId: number;
  readCount: number;
  enqueuedAt: string;
  visibleAt: string;
  message: OrchestratorQueueMessage;
}

export interface QueueReadOptions {
  visibilitySeconds?: number;
  quantity?: number;
}

export interface OrchestratorQueueAdapter {
  read(options?: QueueReadOptions): Promise<QueueDelivery[]>;
  ack(msgId: number): Promise<boolean>;
}

export function parseOrchestratorQueueMessage(value: unknown): OrchestratorQueueMessage {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid orchestrator queue message: expected object");
  }

  const row = value as Record<string, unknown>;
  if (
    row.v !== 1 ||
    typeof row.job_id !== "string" ||
    !row.job_id ||
    typeof row.reason !== "string" ||
    !row.reason ||
    typeof row.trace_id !== "string" ||
    !row.trace_id
  ) {
    throw new Error("Invalid orchestrator queue message contract");
  }

  return {
    v: 1,
    job_id: row.job_id,
    reason: row.reason,
    trace_id: row.trace_id,
  };
}
