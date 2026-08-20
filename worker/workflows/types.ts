import type { GenerationImageRepository } from "../../lib/orchestrator/generation-images";
import type { GenerationVideoRepository } from "../../lib/orchestrator/generation-videos";
import type { ProviderTaskRepository } from "../../lib/orchestrator/provider-tasks";
import type { GameDiscoveryWorkerRepository } from "../../lib/game-discovery/worker-repository";
import type { GameDiscoveryVideoRepository } from "../../lib/game-discovery/video-fanout-repository";
import type { GameDiscoveryAssemblyRuntime } from "../../lib/game-discovery/assembly";
import type { KieClaudeTaskAdapter } from "../../lib/models/kie/claude-task";
import type { KieMarketTaskAdapter } from "../../lib/models/kie/market-task";
import type { KieVeoTaskAdapter } from "../../lib/models/kie/veo-task";
import type {
  ResearchScoutExecutor,
  ResearchScoutRepository,
} from "../../lib/research-intelligence/scout-runtime";

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
  generationVideos: GenerationVideoRepository;
  gameDiscovery?: GameDiscoveryWorkerRepository;
  gameDiscoveryVideo?: GameDiscoveryVideoRepository;
  gameDiscoveryAssembly?: GameDiscoveryAssemblyRuntime;
  researchScouts?: ResearchScoutRepository;
  researchScoutExecutor?: ResearchScoutExecutor | null;
  kieClaude?: KieClaudeTaskAdapter | null;
  kieMarketTask: KieMarketTaskAdapter | null;
  kieVeoTask: KieVeoTaskAdapter | null;
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
  creativeRunId?: string | null;
  enqueueReason?: string | null;
}

export type WorkflowTickHandler = (
  context: WorkflowTickContext,
) => Promise<WorkflowTickOutcome> | WorkflowTickOutcome;
