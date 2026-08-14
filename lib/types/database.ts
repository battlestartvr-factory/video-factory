export type UserRole = "admin" | "member";
export type ProjectStatus = "active" | "archived";
export type MemberRole = "owner" | "editor" | "viewer";
export type JobType = "script" | "post" | "image" | "short_video" | "dev_diary";
export type JobStatus =
  | "draft"
  | "queued"
  | "processing"
  | "review"
  | "completed"
  | "failed"
  | "cancelled";
export type JobMode = "economy" | "balanced" | "quality";
export type AssetKind =
  | "source"
  | "text"
  | "image"
  | "audio"
  | "video"
  | "thumbnail"
  | "other";
export type ReviewDecision = "approved" | "revision_requested";

export interface Profile {
  id: string;
  email: string;
  display_name: string | null;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  default_language: string;
  target_platforms: string[];
  created_by: string;
  factory_settings: Record<string, unknown>;
  system_prompt: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectMember {
  project_id: string;
  user_id: string;
  member_role: MemberRole;
  created_at: string;
  updated_at: string;
}

export interface Job {
  id: string;
  project_id: string;
  created_by: string;
  type: JobType;
  status: JobStatus;
  mode: JobMode;
  language: string;
  target_platform: string;
  brief: string | null;
  source_provider: string;
  source_external_id: string | null;
  source_url: string | null;
  progress: number;
  current_stage: string | null;
  n8n_execution_id: string | null;
  error_code: string | null;
  error_message: string | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobEvent {
  id: string;
  job_id: string;
  event_type: string;
  status: JobStatus | null;
  message: string | null;
  progress: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface Asset {
  id: string;
  project_id: string;
  job_id: string;
  kind: AssetKind;
  provider: string;
  external_id: string | null;
  url: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface Review {
  id: string;
  job_id: string;
  user_id: string;
  decision: ReviewDecision;
  comment: string | null;
  created_at: string;
}

export interface UsageRecord {
  id: string;
  job_id: string;
  provider: string;
  model: string | null;
  operation: string;
  input_units: number | null;
  output_units: number | null;
  cost_usd: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export type ApiSuccess<T> = { ok: true; data: T };
export type ApiError = {
  ok: false;
  error: { code: string; message: string; requestId: string };
};
export type ApiResponse<T> = ApiSuccess<T> | ApiError;
