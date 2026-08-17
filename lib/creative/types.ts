export type CreativeRunType =
  | "research"
  | "concept"
  | "script"
  | "image"
  | "video"
  | "post"
  | "mixed";

export type CreativeRunStatus =
  | "draft"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type CreativeReferenceType =
  | "knowledge"
  | "web"
  | "asset"
  | "creative_run"
  | "manual"
  | "other";

export type CreativeEvaluatorType = "human" | "agent" | "metric";
export type CreativeEvaluationVerdict = "pass" | "fail" | "mixed";
export type CreativeExperimentStatus = "draft" | "running" | "completed" | "cancelled";
export type CreativePreset = "economy" | "balanced" | "quality";

export interface CreativeRun {
  id: string;
  user_id: string;
  project_id: string | null;
  parent_run_id: string | null;
  agent_run_id: string | null;
  factory_job_id: string | null;
  generation_id: string | null;
  run_type: CreativeRunType;
  status: CreativeRunStatus;
  title: string | null;
  objective: string | null;
  hypothesis: string | null;
  prompt: string | null;
  model: string | null;
  provider: string | null;
  preset: CreativePreset | null;
  parameters: Record<string, unknown>;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  usage: Record<string, unknown>;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  error_code: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreativeReference {
  id: string;
  run_id: string;
  user_id: string;
  project_id: string | null;
  reference_type: CreativeReferenceType;
  source_id: string | null;
  source_url: string | null;
  title: string | null;
  excerpt: string | null;
  relevance: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CreativeEvaluation {
  id: string;
  run_id: string;
  user_id: string | null;
  evaluator_type: CreativeEvaluatorType;
  evaluator: string | null;
  verdict: CreativeEvaluationVerdict | null;
  overall_score: number | null;
  dimensions: Record<string, unknown>;
  rationale: string | null;
  evidence: unknown[];
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CreativeExperiment {
  id: string;
  user_id: string;
  project_id: string | null;
  name: string;
  hypothesis: string;
  status: CreativeExperimentStatus;
  success_metric: string | null;
  success_criteria: Record<string, unknown>;
  variables: Record<string, unknown>;
  conclusion: string | null;
  winner_run_id: string | null;
  metadata: Record<string, unknown>;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreativeExperimentRun {
  experiment_id: string;
  run_id: string;
  variant_key: string;
  is_control: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CreateCreativeRunInput {
  userId: string;
  projectId?: string | null;
  parentRunId?: string | null;
  agentRunId?: string | null;
  factoryJobId?: string | null;
  generationId?: string | null;
  runType: CreativeRunType;
  status?: CreativeRunStatus;
  title?: string | null;
  objective?: string | null;
  hypothesis?: string | null;
  prompt?: string | null;
  model?: string | null;
  provider?: string | null;
  preset?: CreativePreset | null;
  parameters?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  estimatedCostUsd?: number | null;
  actualCostUsd?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface AddCreativeReferenceInput {
  runId: string;
  userId: string;
  projectId?: string | null;
  referenceType: CreativeReferenceType;
  sourceId?: string | null;
  sourceUrl?: string | null;
  title?: string | null;
  excerpt?: string | null;
  relevance?: number | null;
  metadata?: Record<string, unknown>;
}

export interface AddCreativeEvaluationInput {
  runId: string;
  userId?: string | null;
  evaluatorType: CreativeEvaluatorType;
  evaluator?: string | null;
  verdict?: CreativeEvaluationVerdict | null;
  overallScore?: number | null;
  dimensions?: Record<string, unknown>;
  rationale?: string | null;
  evidence?: unknown[];
  metadata?: Record<string, unknown>;
}
