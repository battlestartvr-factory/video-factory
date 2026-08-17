import type { GenerationImageRepository } from "../../lib/orchestrator/generation-images";
import type { ProviderTaskRepository } from "../../lib/orchestrator/provider-tasks";
import type { KieMarketTaskAdapter } from "../../lib/models/kie/market-task";

export type DurableTickStatus =
  | "queued"
  | "waiting"
  | "retrying"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowServices {
  providerTasks: ProviderTaskRepository;
  generationImages: GenerationImageRepository;
  kieMarketTask: KieMarketTaskAdapter | null;
  appUrl: string;
}

export interface WorkflowTickContext {
  jobId: string;
  workflowKind: string;
  workflowVersion: number;
  currentStage: string | null;
  state: Record<string, unknown>;
  retryCount: number;
  signal: AbortSignal;
  workerId?: string;
  leaseToken?: string;
  services?: WorkflowServices;
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
