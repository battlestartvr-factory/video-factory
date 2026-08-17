import { requireRpcObject, type OrchestratorRpcClient } from "./rpc";

export interface PreparedProviderTask {
  providerTaskId: string;
  stageId: string;
  status: string;
  externalTaskId: string | null;
  callbackToken: string;
  submissionAttempts: number;
  shouldSubmit: boolean;
}

export class ProviderTaskRepository {
  constructor(private readonly rpcClient: OrchestratorRpcClient) {}

  async prepare(input: {
    jobId: string;
    workerId: string;
    leaseToken: string;
    stage: string;
    stageAttempt?: number;
    providerModelId?: string | null;
    provider: string;
    model: string;
    submissionKey: string;
    variantIndex?: number;
    requestPayload: Record<string, unknown>;
    requestPayloadHash: string;
    creativeRunId?: string | null;
  }): Promise<PreparedProviderTask> {
    const { data, error } = await this.rpcClient.rpc("orchestrator_prepare_provider_task", {
      payload: {
        job_id: input.jobId,
        worker_id: input.workerId,
        lease_token: input.leaseToken,
        stage: input.stage,
        stage_attempt: input.stageAttempt ?? 1,
        provider_model_id: input.providerModelId ?? null,
        provider: input.provider,
        model: input.model,
        submission_key: input.submissionKey,
        variant_index: input.variantIndex ?? 0,
        request_payload: input.requestPayload,
        request_payload_hash: input.requestPayloadHash,
        creative_run_id: input.creativeRunId ?? null,
      },
    });
    if (error) throw new Error(`Failed to prepare provider task: ${error.message}`);
    const row = requireRpcObject(data, "orchestrator_prepare_provider_task");
    if (
      typeof row.provider_task_id !== "string" ||
      typeof row.stage_id !== "string" ||
      typeof row.status !== "string" ||
      typeof row.callback_token !== "string"
    ) {
      throw new Error("Invalid orchestrator_prepare_provider_task response");
    }
    return {
      providerTaskId: row.provider_task_id,
      stageId: row.stage_id,
      status: row.status,
      externalTaskId: typeof row.external_task_id === "string" ? row.external_task_id : null,
      callbackToken: row.callback_token,
      submissionAttempts: typeof row.submission_attempts === "number" ? row.submission_attempts : 0,
      shouldSubmit: row.should_submit === true,
    };
  }

  async recordSubmit(input: {
    providerTaskId: string;
    externalTaskId: string;
    submitPayload?: Record<string, unknown>;
    nextCheckAt?: string | null;
    responsePayloadHash?: string | null;
  }): Promise<void> {
    const { error } = await this.rpcClient.rpc("orchestrator_record_provider_submit", {
      p_provider_task_id: input.providerTaskId,
      p_external_task_id: input.externalTaskId,
      p_submit_payload: input.submitPayload ?? {},
      p_next_check_at: input.nextCheckAt ?? null,
      p_response_payload_hash: input.responsePayloadHash ?? null,
    });
    if (error) throw new Error(`Failed to record provider submit: ${error.message}`);
  }

  async recordStatus(input: {
    providerTaskId: string;
    externalTaskId: string;
    providerState: string;
    statusPayload?: Record<string, unknown>;
    nextCheckAt?: string | null;
    creditsUsed?: number | null;
    responsePayloadHash?: string | null;
  }): Promise<{ status: string; error?: Record<string, unknown> | null }> {
    const { data, error } = await this.rpcClient.rpc("orchestrator_record_provider_status", {
      p_provider_task_id: input.providerTaskId,
      p_external_task_id: input.externalTaskId,
      p_provider_state: input.providerState,
      p_status_payload: input.statusPayload ?? {},
      p_next_check_at: input.nextCheckAt ?? null,
      p_credits_used: input.creditsUsed ?? null,
      p_response_payload_hash: input.responsePayloadHash ?? null,
    });
    if (error) throw new Error(`Failed to record provider status: ${error.message}`);
    const row = requireRpcObject(data, "orchestrator_record_provider_status");
    return {
      status: typeof row.status === "string" ? row.status : "unknown",
      error:
        row.error && typeof row.error === "object" && !Array.isArray(row.error)
          ? (row.error as Record<string, unknown>)
          : null,
    };
  }
}
