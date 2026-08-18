import { requireRpcObject, type OrchestratorRpcClient } from "./rpc";

export interface DurableVideoGeneration {
  id: string;
  prompt: string;
  modelId: string;
  mode: string;
  settings: Record<string, unknown>;
  referenceAssets: Array<{
    id?: string;
    url?: string;
    mimeType?: string;
    filename?: string;
    role?: string;
  }>;
  status: string;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export class GenerationVideoRepository {
  constructor(private readonly rpcClient: OrchestratorRpcClient) {}

  async get(jobId: string): Promise<DurableVideoGeneration | null> {
    const { data, error } = await this.rpcClient.rpc("orchestrator_get_video_generation", {
      p_job_id: jobId,
    });
    if (error) throw new Error(`Failed to load durable video generation: ${error.message}`);
    const row = requireRpcObject(data, "orchestrator_get_video_generation");
    if (row.found !== true) return null;

    const generation = objectValue(row.generation);
    if (
      typeof generation.id !== "string" ||
      typeof generation.prompt !== "string" ||
      typeof generation.model_id !== "string" ||
      typeof generation.mode !== "string" ||
      typeof generation.status !== "string"
    ) {
      throw new Error("Invalid orchestrator_get_video_generation response");
    }

    return {
      id: generation.id,
      prompt: generation.prompt,
      modelId: generation.model_id,
      mode: generation.mode,
      settings: objectValue(generation.settings),
      referenceAssets: Array.isArray(generation.reference_assets)
        ? generation.reference_assets.filter(
            (item): item is DurableVideoGeneration["referenceAssets"][number] =>
              Boolean(item && typeof item === "object" && !Array.isArray(item)),
          )
        : [],
      status: generation.status,
    };
  }

  async markProcessing(jobId: string, providerTaskId: string): Promise<void> {
    const { error } = await this.rpcClient.rpc("orchestrator_mark_video_generation_processing", {
      p_job_id: jobId,
      p_provider_task_id: providerTaskId,
    });
    if (error) throw new Error(`Failed to mark video generation processing: ${error.message}`);
  }

  async complete(input: {
    jobId: string;
    providerTaskId: string;
    outputs: Array<{ url: string; kind: "video"; mimeType?: string }>;
  }): Promise<void> {
    const { error } = await this.rpcClient.rpc("orchestrator_complete_video_generation", {
      p_job_id: input.jobId,
      p_provider_task_id: input.providerTaskId,
      p_outputs: input.outputs,
    });
    if (error) throw new Error(`Failed to complete video generation: ${error.message}`);
  }

  async fail(input: {
    jobId: string;
    providerTaskId?: string | null;
    errorCode: string;
    errorMessage: string;
  }): Promise<void> {
    const { error } = await this.rpcClient.rpc("orchestrator_fail_video_generation", {
      p_job_id: input.jobId,
      p_provider_task_id: input.providerTaskId ?? null,
      p_error_code: input.errorCode,
      p_error_message: input.errorMessage,
    });
    if (error) throw new Error(`Failed to fail video generation: ${error.message}`);
  }
}
