/** Factory pipeline TypeScript contracts — synced with DB and n8n executor TZ. */

export type FactoryJobType =
  | "script"
  | "post"
  | "image"
  | "short_video"
  | "dev_diary";

export type FactoryPreset = "economy" | "balanced" | "quality";

export type FactoryJobStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled";

export type FactoryStageStatus =
  | "queued"
  | "running"
  | "submitted"
  | "processing"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ContentNamespace = "dev_reality" | "ai_game_lab";

export type FactoryAssetKind =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "metadata";

export type FactoryAssetStorage = "inline" | "b2" | "drive";

export type FactoryApprovalDecision = "approve" | "regenerate" | "cancel";

export interface CreateFactoryJobRequest {
  requestId?: string;
  projectId: string;
  jobType: FactoryJobType;
  preset: FactoryPreset;
  contentNamespace: ContentNamespace;
  prompt: string;
  variants?: number;
  durationSeconds?: number;
  aspectRatio?: string;
  sourceAssetIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface CreateFactoryJobResponse {
  jobId: string;
  requestId: string;
  status: FactoryJobStatus;
  accepted: true;
}

export interface FactoryJobActionRequest {
  requestId?: string;
  decision: FactoryApprovalDecision;
  stage: string;
  comment?: string | null;
  selectedAssetId?: string | null;
}

export interface FactoryJobActionResponse {
  jobId: string;
  requestId: string;
  decision: FactoryApprovalDecision;
  accepted: true;
}

export interface FactoryJobStageSummary {
  id: string;
  stage: string;
  status: FactoryStageStatus;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FactoryAsset {
  id: string;
  jobId: string;
  stageId: string | null;
  variantIndex: number;
  kind: FactoryAssetKind;
  storage: FactoryAssetStorage;
  sourceUrl: string | null;
  driveWebUrl: string | null;
  textContent: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  approved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FactoryApproval {
  id: string;
  requestId: string;
  jobId: string;
  userId: string;
  stage: string;
  decision: FactoryApprovalDecision;
  comment: string | null;
  selectedAssetId: string | null;
  createdAt: string;
}

export interface FactoryJobDetail {
  id: string;
  requestId: string;
  projectId: string;
  userId: string;
  jobType: FactoryJobType;
  preset: FactoryPreset;
  contentNamespace: ContentNamespace;
  conceptDisclosureRequired: boolean;
  status: FactoryJobStatus;
  currentStage: string | null;
  progress: number;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  error: NormalizedFactoryError | null;
  cancelRequested: boolean;
  estimatedCostUsd: number | null;
  actualCostUsd: number;
  aggregatedActualCostUsd: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  stages: FactoryJobStageSummary[];
  assets: FactoryAsset[];
  approvals: FactoryApproval[];
}

export interface NormalizedFactoryError {
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

/** Outbound n8n payloads (server-only). */
export interface N8nFactoryJobCreatedPayload {
  event: "factory.job.created";
  requestId: string;
  jobId: string;
  projectId: string;
  userId: string;
  jobType: FactoryJobType;
  preset: FactoryPreset;
  contentNamespace: ContentNamespace;
  conceptDisclosureRequired: boolean;
  input: Record<string, unknown>;
  createdAt: string;
}

export interface N8nFactoryJobActionPayload {
  event: "factory.job.action";
  requestId: string;
  jobId: string;
  projectId: string;
  userId: string;
  decision: FactoryApprovalDecision;
  stage: string;
  comment: string | null;
  selectedAssetId: string | null;
  createdAt: string;
}
