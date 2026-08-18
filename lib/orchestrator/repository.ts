import { requireRpcObject, type OrchestratorRpcClient } from "./rpc";

export interface ClaimedJob {
  claimed: true;
  jobId: string;
  workflowKind: string;
  workflowVersion: number;
  currentStage: string | null;
  state: Record<string, unknown>;
  retryCount: number;
  leaseToken: string;
  leaseExpiresAt: string;
  recovered: boolean;
}

export interface UnclaimedJob {
  claimed: false;
  reason: string;
  status?: string;
  nextActionAt?: string;
  leaseExpiresAt?: string;
}

export type ClaimJobResult = ClaimedJob | UnclaimedJob;

export interface FinishTickInput {
  jobId: string;
  workerId: string;
  leaseToken: string;
  newStatus:
    | "queued"
    | "waiting"
    | "retrying"
    | "awaiting_approval"
    | "completed"
    | "failed"
    | "cancelled";
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
  traceId?: string | null;
}

export interface FinishTickResult {
  success: boolean;
  reason?: string;
  status?: string;
  retryCount?: number;
  queueMsgId?: number;
  nextActionAt?: string;
  traceId?: string;
}

export class OrchestratorRepository {
  constructor(private readonly rpcClient: OrchestratorRpcClient) {}

  async claimJob(jobId: string, workerId: string, leaseSeconds = 90): Promise<ClaimJobResult> {
    const { data, error } = await this.rpcClient.rpc("orchestrator_claim_job", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    });

    if (error) throw new Error(`Failed to claim orchestrator job ${jobId}: ${error.message}`);
    const row = requireRpcObject(data, "orchestrator_claim_job");

    if (row.claimed !== true) {
      return {
        claimed: false,
        reason: typeof row.reason === "string" ? row.reason : "unknown",
        status: typeof row.status === "string" ? row.status : undefined,
        nextActionAt: typeof row.next_action_at === "string" ? row.next_action_at : undefined,
        leaseExpiresAt:
          typeof row.lease_expires_at === "string" ? row.lease_expires_at : undefined,
      };
    }

    if (
      typeof row.job_id !== "string" ||
      typeof row.workflow_kind !== "string" ||
      typeof row.workflow_version !== "number" ||
      typeof row.lease_token !== "string" ||
      typeof row.lease_expires_at !== "string"
    ) {
      throw new Error("Invalid claimed-job RPC response");
    }

    return {
      claimed: true,
      jobId: row.job_id,
      workflowKind: row.workflow_kind,
      workflowVersion: row.workflow_version,
      currentStage: typeof row.current_stage === "string" ? row.current_stage : null,
      state:
        row.state && typeof row.state === "object" && !Array.isArray(row.state)
          ? (row.state as Record<string, unknown>)
          : {},
      retryCount: typeof row.retry_count === "number" ? row.retry_count : 0,
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at,
      recovered: row.recovered === true,
    };
  }

  async heartbeatJob(input: {
    jobId: string;
    workerId: string;
    leaseToken: string;
    msgId: number;
    leaseSeconds?: number;
    visibilitySeconds?: number;
  }): Promise<{ renewed: boolean; reason?: string; leaseExpiresAt?: string }> {
    const { data, error } = await this.rpcClient.rpc("orchestrator_heartbeat_job", {
      p_job_id: input.jobId,
      p_worker_id: input.workerId,
      p_lease_token: input.leaseToken,
      p_msg_id: input.msgId,
      p_lease_seconds: input.leaseSeconds ?? 90,
      p_visibility_seconds: input.visibilitySeconds ?? 120,
    });

    if (error) throw new Error(`Failed to heartbeat orchestrator job ${input.jobId}: ${error.message}`);
    const row = requireRpcObject(data, "orchestrator_heartbeat_job");
    return {
      renewed: row.renewed === true,
      reason: typeof row.reason === "string" ? row.reason : undefined,
      leaseExpiresAt:
        typeof row.lease_expires_at === "string" ? row.lease_expires_at : undefined,
    };
  }

  async finishTick(input: FinishTickInput): Promise<FinishTickResult> {
    const { data, error } = await this.rpcClient.rpc("orchestrator_finish_tick", {
      p_job_id: input.jobId,
      p_worker_id: input.workerId,
      p_lease_token: input.leaseToken,
      p_new_status: input.newStatus,
      p_state: input.state ?? null,
      p_current_stage: input.currentStage ?? null,
      p_progress: input.progress ?? null,
      p_next_action_at: input.nextActionAt ?? null,
      p_result: input.result ?? null,
      p_error: input.error ?? null,
      p_state_reason: input.stateReason ?? null,
      p_event_type: input.eventType ?? "job.transitioned",
      p_event_payload: input.eventPayload ?? {},
      p_creative_run_id: input.creativeRunId ?? null,
      p_enqueue_reason: input.enqueueReason ?? null,
      p_trace_id: input.traceId ?? null,
    });

    if (error) throw new Error(`Failed to finish orchestrator job ${input.jobId}: ${error.message}`);
    const row = requireRpcObject(data, "orchestrator_finish_tick");
    return {
      success: row.success === true,
      reason: typeof row.reason === "string" ? row.reason : undefined,
      status: typeof row.status === "string" ? row.status : undefined,
      retryCount: typeof row.retry_count === "number" ? row.retry_count : undefined,
      queueMsgId: typeof row.queue_msg_id === "number" ? row.queue_msg_id : undefined,
      nextActionAt:
        typeof row.next_action_at === "string" ? row.next_action_at : undefined,
      traceId: typeof row.trace_id === "string" ? row.trace_id : undefined,
    };
  }

  async heartbeatWorker(input: {
    workerId: string;
    buildSha?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const { error } = await this.rpcClient.rpc("orchestrator_worker_heartbeat", {
      p_worker_id: input.workerId,
      p_build_sha: input.buildSha ?? null,
      p_metadata: input.metadata ?? {},
    });
    if (error) throw new Error(`Failed to heartbeat worker ${input.workerId}: ${error.message}`);
  }

  async recoverDueJobs(input: {
    limit?: number;
    reenqueueAfterSeconds?: number;
  } = {}): Promise<{ recovered: number; staleLeases: number }> {
    const { data, error } = await this.rpcClient.rpc("orchestrator_watchdog_recover", {
      p_limit: input.limit ?? 50,
      p_reenqueue_after_seconds: input.reenqueueAfterSeconds ?? 60,
    });
    if (error) throw new Error(`Failed to run orchestrator watchdog: ${error.message}`);
    const row = requireRpcObject(data, "orchestrator_watchdog_recover");
    return {
      recovered: typeof row.recovered === "number" ? row.recovered : 0,
      staleLeases: typeof row.stale_leases === "number" ? row.stale_leases : 0,
    };
  }
}
