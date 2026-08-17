import "server-only";

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { assertProjectAccess } from "@/lib/projects/access";
import type {
  AddCreativeEvaluationInput,
  AddCreativeReferenceInput,
  CreateCreativeRunInput,
  CreativeEvaluation,
  CreativeExperiment,
  CreativeExperimentRun,
  CreativeReference,
  CreativeRun,
} from "@/lib/creative/types";

async function assertOptionalProjectAccess(userId: string, projectId?: string | null) {
  if (projectId) await assertProjectAccess(userId, projectId);
}

async function assertRecordAccess(input: {
  userId: string;
  ownerUserId: string;
  projectId?: string | null;
}): Promise<void> {
  if (input.ownerUserId === input.userId) return;
  if (!input.projectId) throw new Error("FORBIDDEN");
  await assertProjectAccess(input.userId, input.projectId);
}

export async function createCreativeRun(input: CreateCreativeRunInput): Promise<CreativeRun> {
  await assertOptionalProjectAccess(input.userId, input.projectId);

  if (input.parentRunId) {
    const parent = await getCreativeRun({ userId: input.userId, runId: input.parentRunId });
    if (!parent) throw new Error("PARENT_CREATIVE_RUN_NOT_FOUND");
    if ((parent.project_id ?? null) !== (input.projectId ?? null)) {
      throw new Error("PARENT_CREATIVE_RUN_PROJECT_MISMATCH");
    }
  }

  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("creative_runs")
    .insert({
      user_id: input.userId,
      project_id: input.projectId ?? null,
      parent_run_id: input.parentRunId ?? null,
      agent_run_id: input.agentRunId ?? null,
      factory_job_id: input.factoryJobId ?? null,
      generation_id: input.generationId ?? null,
      run_type: input.runType,
      status: input.status ?? "draft",
      title: input.title ?? null,
      objective: input.objective ?? null,
      hypothesis: input.hypothesis ?? null,
      prompt: input.prompt ?? null,
      model: input.model ?? null,
      provider: input.provider ?? null,
      preset: input.preset ?? null,
      parameters: input.parameters ?? {},
      inputs: input.inputs ?? {},
      outputs: input.outputs ?? {},
      usage: input.usage ?? {},
      estimated_cost_usd: input.estimatedCostUsd ?? null,
      actual_cost_usd: input.actualCostUsd ?? null,
      metadata: input.metadata ?? {},
      started_at: input.startedAt ?? null,
      completed_at: input.completedAt ?? null,
    })
    .select()
    .single();

  if (error || !data) throw new Error(`Failed to create creative run: ${error?.message ?? "unknown"}`);
  return data as CreativeRun;
}

export async function getCreativeRun(input: {
  userId: string;
  runId: string;
}): Promise<CreativeRun | null> {
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("creative_runs")
    .select("*")
    .eq("id", input.runId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load creative run: ${error.message}`);
  if (!data) return null;

  const run = data as CreativeRun;
  await assertRecordAccess({
    userId: input.userId,
    ownerUserId: run.user_id,
    projectId: run.project_id,
  });
  return run;
}

export async function listCreativeRuns(input: {
  userId: string;
  projectId?: string | null;
  status?: string | null;
  limit?: number;
}): Promise<CreativeRun[]> {
  await assertOptionalProjectAccess(input.userId, input.projectId);
  const service = createSupabaseServiceClient();
  let query = service
    .from("creative_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(input.limit ?? 50);

  if (input.projectId) query = query.eq("project_id", input.projectId);
  else query = query.eq("user_id", input.userId);
  if (input.status) query = query.eq("status", input.status);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to list creative runs: ${error.message}`);
  return (data ?? []) as CreativeRun[];
}

export async function updateCreativeRun(
  userId: string,
  runId: string,
  updates: Partial<Pick<
    CreativeRun,
    | "status"
    | "title"
    | "objective"
    | "hypothesis"
    | "prompt"
    | "model"
    | "provider"
    | "preset"
    | "parameters"
    | "inputs"
    | "outputs"
    | "usage"
    | "estimated_cost_usd"
    | "actual_cost_usd"
    | "error_code"
    | "error_message"
    | "metadata"
    | "started_at"
    | "completed_at"
  >>,
): Promise<CreativeRun> {
  const existing = await getCreativeRun({ userId, runId });
  if (!existing) throw new Error("CREATIVE_RUN_NOT_FOUND");

  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("creative_runs")
    .update(updates)
    .eq("id", runId)
    .select()
    .single();

  if (error || !data) throw new Error(`Failed to update creative run: ${error?.message ?? "unknown"}`);
  return data as CreativeRun;
}

export async function addCreativeReference(
  input: AddCreativeReferenceInput,
): Promise<CreativeReference> {
  const run = await getCreativeRun({ userId: input.userId, runId: input.runId });
  if (!run) throw new Error("CREATIVE_RUN_NOT_FOUND");
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("creative_references")
    .insert({
      run_id: input.runId,
      user_id: input.userId,
      project_id: run.project_id,
      reference_type: input.referenceType,
      source_id: input.sourceId ?? null,
      source_url: input.sourceUrl ?? null,
      title: input.title ?? null,
      excerpt: input.excerpt ?? null,
      relevance: input.relevance ?? null,
      metadata: input.metadata ?? {},
    })
    .select()
    .single();

  if (error || !data) throw new Error(`Failed to add creative reference: ${error?.message ?? "unknown"}`);
  return data as CreativeReference;
}

export async function listCreativeReferences(input: {
  userId: string;
  runId: string;
}): Promise<CreativeReference[]> {
  const run = await getCreativeRun(input);
  if (!run) return [];
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("creative_references")
    .select("*")
    .eq("run_id", input.runId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to list creative references: ${error.message}`);
  return (data ?? []) as CreativeReference[];
}

export async function addCreativeEvaluation(
  input: AddCreativeEvaluationInput & { actorUserId: string },
): Promise<CreativeEvaluation> {
  const run = await getCreativeRun({ userId: input.actorUserId, runId: input.runId });
  if (!run) throw new Error("CREATIVE_RUN_NOT_FOUND");
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("creative_evaluations")
    .insert({
      run_id: input.runId,
      user_id: input.userId ?? null,
      evaluator_type: input.evaluatorType,
      evaluator: input.evaluator ?? null,
      verdict: input.verdict ?? null,
      overall_score: input.overallScore ?? null,
      dimensions: input.dimensions ?? {},
      rationale: input.rationale ?? null,
      evidence: input.evidence ?? [],
      metadata: input.metadata ?? {},
    })
    .select()
    .single();

  if (error || !data) throw new Error(`Failed to add creative evaluation: ${error?.message ?? "unknown"}`);
  return data as CreativeEvaluation;
}

export async function listCreativeEvaluations(input: {
  userId: string;
  runId: string;
}): Promise<CreativeEvaluation[]> {
  const run = await getCreativeRun(input);
  if (!run) return [];
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("creative_evaluations")
    .select("*")
    .eq("run_id", input.runId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to list creative evaluations: ${error.message}`);
  return (data ?? []) as CreativeEvaluation[];
}

export async function createCreativeExperiment(input: {
  userId: string;
  projectId?: string | null;
  name: string;
  hypothesis: string;
  successMetric?: string | null;
  successCriteria?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<CreativeExperiment> {
  await assertOptionalProjectAccess(input.userId, input.projectId);
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("creative_experiments")
    .insert({
      user_id: input.userId,
      project_id: input.projectId ?? null,
      name: input.name,
      hypothesis: input.hypothesis,
      success_metric: input.successMetric ?? null,
      success_criteria: input.successCriteria ?? {},
      variables: input.variables ?? {},
      metadata: input.metadata ?? {},
    })
    .select()
    .single();

  if (error || !data) throw new Error(`Failed to create creative experiment: ${error?.message ?? "unknown"}`);
  return data as CreativeExperiment;
}

export async function attachRunToExperiment(input: {
  userId: string;
  experimentId: string;
  runId: string;
  variantKey: string;
  isControl?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<CreativeExperimentRun> {
  const run = await getCreativeRun({ userId: input.userId, runId: input.runId });
  if (!run) throw new Error("CREATIVE_RUN_NOT_FOUND");

  const service = createSupabaseServiceClient();
  const { data: experiment, error: experimentError } = await service
    .from("creative_experiments")
    .select("id,user_id,project_id")
    .eq("id", input.experimentId)
    .maybeSingle();
  if (experimentError) throw new Error(`Failed to load creative experiment: ${experimentError.message}`);
  if (!experiment) throw new Error("CREATIVE_EXPERIMENT_NOT_FOUND");

  await assertRecordAccess({
    userId: input.userId,
    ownerUserId: experiment.user_id as string,
    projectId: experiment.project_id as string | null,
  });

  if ((experiment.project_id ?? null) !== (run.project_id ?? null)) {
    throw new Error("CREATIVE_EXPERIMENT_PROJECT_MISMATCH");
  }

  const { data, error } = await service
    .from("creative_experiment_runs")
    .insert({
      experiment_id: input.experimentId,
      run_id: input.runId,
      variant_key: input.variantKey,
      is_control: input.isControl ?? false,
      metadata: input.metadata ?? {},
    })
    .select()
    .single();

  if (error || !data) throw new Error(`Failed to attach run to experiment: ${error?.message ?? "unknown"}`);
  return data as CreativeExperimentRun;
}
