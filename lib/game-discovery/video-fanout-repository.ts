import type { OrchestratorRpcClient } from "../orchestrator/rpc";
import { requireRpcObject } from "../orchestrator/rpc";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface GameplayVideoStageItem {
  shotId: string;
  conceptId: string;
  momentId: string;
  conceptRunId: string;
  generationId: string;
  factoryJobId: string;
  approvedReferenceGenerationId: string;
  status: string;
  outputs: Array<Record<string, unknown>>;
  errorMessage: string | null;
  modelId: string | null;
}

export interface GameplayVideoStage {
  items: GameplayVideoStageItem[];
  requestCount: number;
  allTerminal: boolean;
  allCompleted: boolean;
}

function parseVideoItem(value: unknown): GameplayVideoStageItem | null {
  const row = object(value);
  const shotId = text(row.shot_id);
  const conceptId = text(row.concept_id);
  const momentId = text(row.moment_id);
  const conceptRunId = text(row.concept_run_id);
  const generationId = text(row.generation_id);
  const factoryJobId = text(row.factory_job_id);
  const approvedReferenceGenerationId = text(row.approved_reference_generation_id);
  const status = text(row.status);

  if (
    !shotId ||
    !conceptId ||
    !momentId ||
    !conceptRunId ||
    !generationId ||
    !factoryJobId ||
    !approvedReferenceGenerationId ||
    !status
  ) {
    return null;
  }

  return {
    shotId,
    conceptId,
    momentId,
    conceptRunId,
    generationId,
    factoryJobId,
    approvedReferenceGenerationId,
    status,
    outputs: array(row.outputs).map(object),
    errorMessage: text(row.error_message),
    modelId: text(row.model_id),
  };
}

export class GameDiscoveryVideoRepository {
  constructor(private readonly client: OrchestratorRpcClient) {}

  async createApprovedVideo(input: {
    rootJobId: string;
    rootCreativeRunId: string;
    requestId: string;
    referenceGenerationId: string;
    shotId: string;
  }): Promise<{ generationId: string; factoryJobId: string; duplicate: boolean }> {
    const { data, error } = await this.client.rpc("orchestrator_create_approved_gameplay_video", {
      payload: {
        root_job_id: input.rootJobId,
        root_creative_run_id: input.rootCreativeRunId,
        request_id: input.requestId,
        reference_generation_id: input.referenceGenerationId,
        shot_id: input.shotId,
      },
    });
    if (error) throw new Error(`Failed to admit approved gameplay video: ${error.message}`);

    const row = requireRpcObject(data, "approved gameplay video admission");
    const generation = object(row.generation);
    if (typeof generation.id !== "string" || typeof row.factory_job_id !== "string") {
      throw new Error("Invalid approved gameplay video admission response");
    }

    return {
      generationId: generation.id,
      factoryJobId: row.factory_job_id,
      duplicate: row.duplicate === true,
    };
  }

  async getGameplayVideoStage(input: { rootCreativeRunId: string }): Promise<GameplayVideoStage> {
    const { data, error } = await this.client.rpc("orchestrator_get_gameplay_video_stage", {
      payload: { root_creative_run_id: input.rootCreativeRunId },
    });
    if (error) throw new Error(`Failed to inspect gameplay video stage: ${error.message}`);

    const row = requireRpcObject(data, "gameplay video stage");
    return {
      items: array(row.items)
        .map(parseVideoItem)
        .filter((item): item is GameplayVideoStageItem => item !== null),
      requestCount: typeof row.request_count === "number" ? row.request_count : 0,
      allTerminal: row.all_terminal === true,
      allCompleted: row.all_completed === true,
    };
  }
}
