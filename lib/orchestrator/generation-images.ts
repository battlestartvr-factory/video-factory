import { getDefaultMediaArchiveService } from "./media-archive";
import { requireRpcObject, type OrchestratorRpcClient } from "./rpc";

export interface DurableImageGeneration {
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

export interface DurableImageOutput {
  url: string;
  kind: "image";
  mimeType?: string;
  providerUrl?: string;
  storageProvider?: "google_drive";
  driveFileId?: string;
  driveWebUrl?: string | null;
  filename?: string;
  sizeBytes?: number | null;
  archivedAt?: string;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export class GenerationImageRepository {
  constructor(private readonly rpcClient: OrchestratorRpcClient) {}

  async get(jobId: string): Promise<DurableImageGeneration | null> {
    const { data, error } = await this.rpcClient.rpc("orchestrator_get_image_generation", {
      p_job_id: jobId,
    });
    if (error) throw new Error(`Failed to load durable image generation: ${error.message}`);
    const row = requireRpcObject(data, "orchestrator_get_image_generation");
    if (row.found !== true) return null;

    const generation = objectValue(row.generation);
    if (
      typeof generation.id !== "string" ||
      typeof generation.prompt !== "string" ||
      typeof generation.model_id !== "string" ||
      typeof generation.mode !== "string" ||
      typeof generation.status !== "string"
    ) {
      throw new Error("Invalid orchestrator_get_image_generation response");
    }

    return {
      id: generation.id,
      prompt: generation.prompt,
      modelId: generation.model_id,
      mode: generation.mode,
      settings: objectValue(generation.settings),
      referenceAssets: Array.isArray(generation.reference_assets)
        ? generation.reference_assets.filter(
            (item): item is DurableImageGeneration["referenceAssets"][number] =>
              Boolean(item && typeof item === "object" && !Array.isArray(item)),
          )
        : [],
      status: generation.status,
    };
  }

  async markProcessing(jobId: string, providerTaskId: string): Promise<void> {
    const { error } = await this.rpcClient.rpc("orchestrator_mark_image_generation_processing", {
      p_job_id: jobId,
      p_provider_task_id: providerTaskId,
    });
    if (error) throw new Error(`Failed to mark image generation processing: ${error.message}`);
  }

  async complete(input: {
    jobId: string;
    providerTaskId: string;
    outputs: DurableImageOutput[];
  }): Promise<void> {
    let persistedOutputs: DurableImageOutput[] = input.outputs;
    const archive = getDefaultMediaArchiveService();
    if (archive) {
      const generation = await this.get(input.jobId);
      if (!generation) throw new Error("Image generation not found while archiving output");

      const archived: DurableImageOutput[] = [];
      for (let index = 0; index < input.outputs.length; index += 1) {
        const output = input.outputs[index]!;
        const stored = await archive.archive({
          generationId: generation.id,
          outputIndex: index,
          sourceUrl: output.providerUrl ?? output.url,
          kind: "image",
        });
        archived.push({ ...stored, kind: "image" });
      }
      persistedOutputs = archived;
    }

    const { error } = await this.rpcClient.rpc("orchestrator_complete_image_generation", {
      p_job_id: input.jobId,
      p_provider_task_id: input.providerTaskId,
      p_outputs: persistedOutputs,
    });
    if (error) throw new Error(`Failed to complete image generation: ${error.message}`);
  }

  async fail(input: {
    jobId: string;
    providerTaskId?: string | null;
    errorCode: string;
    errorMessage: string;
  }): Promise<void> {
    const { error } = await this.rpcClient.rpc("orchestrator_fail_image_generation", {
      p_job_id: input.jobId,
      p_provider_task_id: input.providerTaskId ?? null,
      p_error_code: input.errorCode,
      p_error_message: input.errorMessage,
    });
    if (error) throw new Error(`Failed to fail image generation: ${error.message}`);
  }
}
