import type { OrchestratorRpcClient } from "../orchestrator/rpc";
import { requireRpcObject } from "../orchestrator/rpc";
import type { GameplayPrototypeAssembly } from "./assembly";
import type { AssetGraphV1 } from "./schemas";

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

export interface GameplayVideoApprovalItem extends GameplayVideoStageItem {
  decision: "approve" | "reject" | "revise" | null;
  reviewId: string | null;
  rawFeedback: string | null;
  structuredFeedback: Record<string, unknown>;
}

export interface GameplayVideoApprovalStage {
  items: GameplayVideoApprovalItem[];
  requestCount: number;
  allReviewed: boolean;
  allApproved: boolean;
}

export interface GameplayAssemblyStage {
  items: GameplayPrototypeAssembly[];
  assemblyCount: number;
}

function parseVideoItem(value: unknown, approval = false): GameplayVideoStageItem | GameplayVideoApprovalItem | null {
  const row = object(value);
  const shotId = text(row.shot_id);
  const conceptId = text(row.concept_id);
  const momentId = text(row.moment_id);
  const conceptRunId = text(row.concept_run_id);
  const generationId = text(row.generation_id);
  const factoryJobId = text(row.factory_job_id);
  const approvedReferenceGenerationId = text(row.approved_reference_generation_id);
  const status = text(approval ? row.generation_status : row.status);

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

  const base: GameplayVideoStageItem = {
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
  if (!approval) return base;

  const decision = row.decision;
  return {
    ...base,
    decision:
      decision === "approve" || decision === "reject" || decision === "revise" ? decision : null,
    reviewId: text(row.review_id),
    rawFeedback: text(row.raw_feedback),
    structuredFeedback: object(row.structured_feedback),
  };
}

function parseAssembly(value: unknown): GameplayPrototypeAssembly | null {
  const row = object(value);
  const generationIds = array(row.inputVideoGenerationIds).filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  if (
    row.schema !== "gameplay_short_assembly" ||
    row.version !== 1 ||
    !text(row.rootCreativeRunId) ||
    !text(row.conceptRunId) ||
    !text(row.conceptId) ||
    generationIds.length === 0 ||
    !text(row.driveFileId) ||
    !text(row.filename) ||
    row.mimeType !== "video/mp4" ||
    typeof row.sizeBytes !== "number" ||
    !text(row.sha256) ||
    typeof row.durationSeconds !== "number" ||
    typeof row.width !== "number" ||
    typeof row.height !== "number" ||
    typeof row.fps !== "number" ||
    !text(row.videoCodec) ||
    row.audioIncluded !== false ||
    !text(row.archivedAt)
  ) {
    return null;
  }
  return row as unknown as GameplayPrototypeAssembly;
}

export class GameDiscoveryVideoRepository {
  constructor(private readonly client: OrchestratorRpcClient) {}

  async createApprovedVideo(input: {
    rootJobId: string;
    rootCreativeRunId: string;
    requestId: string;
    referenceGenerationId: string;
    shotId: string;
    videoPromptOverride?: string | null;
    sourceVideoGenerationId?: string | null;
    revisionReviewId?: string | null;
    videoRevisionNumber?: number;
  }): Promise<{ generationId: string; factoryJobId: string; duplicate: boolean }> {
    const { data, error } = await this.client.rpc("orchestrator_create_approved_gameplay_video", {
      payload: {
        root_job_id: input.rootJobId,
        root_creative_run_id: input.rootCreativeRunId,
        request_id: input.requestId,
        reference_generation_id: input.referenceGenerationId,
        shot_id: input.shotId,
        video_prompt_override: input.videoPromptOverride ?? null,
        source_video_generation_id: input.sourceVideoGenerationId ?? null,
        revision_review_id: input.revisionReviewId ?? null,
        video_revision_number: input.videoRevisionNumber ?? 0,
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
        .map((item) => parseVideoItem(item))
        .filter((item): item is GameplayVideoStageItem => item !== null),
      requestCount: typeof row.request_count === "number" ? row.request_count : 0,
      allTerminal: row.all_terminal === true,
      allCompleted: row.all_completed === true,
    };
  }

  async getGameplayVideoApprovalStage(input: {
    rootCreativeRunId: string;
  }): Promise<GameplayVideoApprovalStage> {
    const { data, error } = await this.client.rpc("orchestrator_get_gameplay_video_approval_stage", {
      payload: { root_creative_run_id: input.rootCreativeRunId },
    });
    if (error) throw new Error(`Failed to inspect gameplay video approvals: ${error.message}`);

    const row = requireRpcObject(data, "gameplay video approval stage");
    return {
      items: array(row.items)
        .map((item) => parseVideoItem(item, true))
        .filter((item): item is GameplayVideoApprovalItem => item !== null),
      requestCount: typeof row.request_count === "number" ? row.request_count : 0,
      allReviewed: row.all_reviewed === true,
      allApproved: row.all_approved === true,
    };
  }

  async persistAssetGraph(input: {
    rootJobId: string;
    rootCreativeRunId: string;
    conceptRunId: string;
    assetGraph: AssetGraphV1;
  }): Promise<void> {
    const { error } = await this.client.rpc("orchestrator_persist_gameplay_asset_graph", {
      payload: {
        root_job_id: input.rootJobId,
        root_creative_run_id: input.rootCreativeRunId,
        concept_run_id: input.conceptRunId,
        asset_graph: input.assetGraph,
      },
    });
    if (error) throw new Error(`Failed to persist gameplay asset graph: ${error.message}`);
  }

  async getAssemblyStage(input: { rootCreativeRunId: string }): Promise<GameplayAssemblyStage> {
    const { data, error } = await this.client.rpc("orchestrator_get_gameplay_assembly_stage", {
      payload: { root_creative_run_id: input.rootCreativeRunId },
    });
    if (error) throw new Error(`Failed to inspect gameplay assembly stage: ${error.message}`);
    const row = requireRpcObject(data, "gameplay assembly stage");
    const items = array(row.items)
      .map(parseAssembly)
      .filter((item): item is GameplayPrototypeAssembly => item !== null);
    return {
      items,
      assemblyCount: typeof row.assembly_count === "number" ? row.assembly_count : items.length,
    };
  }

  async persistAssembly(input: {
    rootJobId: string;
    rootCreativeRunId: string;
    conceptRunId: string;
    assembly: GameplayPrototypeAssembly;
    assetGraph: AssetGraphV1;
  }): Promise<void> {
    const { error } = await this.client.rpc("orchestrator_persist_gameplay_assembly", {
      payload: {
        root_job_id: input.rootJobId,
        root_creative_run_id: input.rootCreativeRunId,
        concept_run_id: input.conceptRunId,
        assembly: input.assembly,
        asset_graph: input.assetGraph,
      },
    });
    if (error) throw new Error(`Failed to persist gameplay assembly: ${error.message}`);
  }

  async finalizeDiscoveryBatch(input: {
    rootJobId: string;
    rootCreativeRunId: string;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.client.rpc("orchestrator_finalize_gameplay_discovery_batch", {
      payload: {
        root_job_id: input.rootJobId,
        root_creative_run_id: input.rootCreativeRunId,
      },
    });
    if (error) throw new Error(`Failed to finalize gameplay discovery batch: ${error.message}`);
    const row = requireRpcObject(data, "gameplay discovery finalization");
    return object(row.result);
  }
}
