import "server-only";

import { randomUUID } from "node:crypto";
import { assertProjectAccess } from "@/lib/projects/access";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { CreativeRun } from "@/lib/creative/types";
import { getKieConfig } from "@/lib/env/env.server";
import { KieClaudeTaskAdapter } from "@/lib/models/kie/claude-task";
import {
  gameplayReferenceFeedbackV1Schema,
  structureGameplayReferenceFeedback,
} from "./feedback-memory";
import {
  discoveryObjectiveSpecV1Schema,
  type DiscoveryObjectiveSpecV1,
} from "./schemas";

export interface CreateGameDiscoveryBatchInput {
  requestId?: string;
  userId: string;
  projectId?: string | null;
  objective: DiscoveryObjectiveSpecV1;
  hypothesis?: string | null;
}

export interface CreateGameDiscoveryBatchResult {
  creativeRun: CreativeRun;
  factoryJobId: string;
  duplicate: boolean;
  queueMsgId: number | null;
  traceId: string | null;
}

export interface GameplayReferenceReview {
  id: string;
  root_creative_run_id: string;
  concept_run_id: string;
  generation_id: string | null;
  user_id: string | null;
  concept_id: string;
  moment_id: string;
  shot_id: string;
  decision: "approve" | "reject" | "revise";
  raw_feedback: string | null;
  structured_feedback: Record<string, unknown>;
  error_tags: unknown[];
  must_show: unknown[];
  must_avoid: unknown[];
  reusable_scope: "shot" | "concept" | "project";
  model: string | null;
  usage: Record<string, unknown>;
  created_at: string;
}

export interface GameDiscoveryBatchDetail {
  root: CreativeRun;
  factoryJob: Record<string, unknown> | null;
  conceptRuns: Array<Record<string, unknown>>;
  referenceGenerations: Array<Record<string, unknown>>;
  reviews: GameplayReferenceReview[];
}

function rpcObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function createGameDiscoveryBatch(
  input: CreateGameDiscoveryBatchInput,
): Promise<CreateGameDiscoveryBatchResult> {
  const objective = discoveryObjectiveSpecV1Schema.parse(input.objective);
  if (input.projectId) await assertProjectAccess(input.userId, input.projectId);

  const requestId = input.requestId?.trim() || randomUUID();
  const service = createSupabaseServiceClient();
  const { data, error } = await service.rpc("orchestrator_create_game_discovery_batch", {
    payload: {
      request_id: requestId,
      user_id: input.userId,
      project_id: input.projectId ?? null,
      discovery_objective: objective,
      hypothesis: input.hypothesis?.trim() || null,
    },
  });

  if (error) {
    throw new Error(`Failed to create durable game discovery batch: ${error.message}`);
  }

  const row = rpcObject(data);
  const creativeRun = rpcObject(row.creative_run);
  if (typeof creativeRun.id !== "string" || typeof row.factory_job_id !== "string") {
    throw new Error("Invalid orchestrator_create_game_discovery_batch response");
  }

  return {
    creativeRun: creativeRun as unknown as CreativeRun,
    factoryJobId: row.factory_job_id,
    duplicate: row.duplicate === true,
    queueMsgId: typeof row.queue_msg_id === "number" ? row.queue_msg_id : null,
    traceId: typeof row.trace_id === "string" ? row.trace_id : null,
  };
}

export async function listGameDiscoveryBatches(input: {
  userId: string;
  projectId?: string | null;
  limit?: number;
}): Promise<CreativeRun[]> {
  if (input.projectId) await assertProjectAccess(input.userId, input.projectId);

  const service = createSupabaseServiceClient();
  let query = service
    .from("creative_runs")
    .select("*")
    .contains("metadata", { domain_kind: "game_discovery_batch" })
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(input.limit ?? 20, 1), 100));

  if (input.projectId) query = query.eq("project_id", input.projectId);
  else query = query.eq("user_id", input.userId);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to list game discovery batches: ${error.message}`);
  return (data ?? []) as CreativeRun[];
}

export async function getGameDiscoveryBatch(input: {
  userId: string;
  runId: string;
}): Promise<CreativeRun | null> {
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("creative_runs")
    .select("*")
    .eq("id", input.runId)
    .contains("metadata", { domain_kind: "game_discovery_batch" })
    .maybeSingle();

  if (error) throw new Error(`Failed to load game discovery batch: ${error.message}`);
  if (!data) return null;

  const run = data as CreativeRun;
  if (run.user_id === input.userId) return run;
  if (!run.project_id) return null;
  await assertProjectAccess(input.userId, run.project_id);
  return run;
}

export async function getGameDiscoveryBatchDetail(input: {
  userId: string;
  runId: string;
}): Promise<GameDiscoveryBatchDetail | null> {
  const root = await getGameDiscoveryBatch(input);
  if (!root) return null;
  const service = createSupabaseServiceClient();

  const referenceRequests = rpcObject(rpcObject(root.outputs).reference_image_requests);
  const generationIds = Object.values(referenceRequests)
    .map((value) => rpcObject(value).generation_id)
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  const [jobResult, conceptsResult, generationsResult, reviewsResult] = await Promise.all([
    root.factory_job_id
      ? service.from("factory_jobs").select("*").eq("id", root.factory_job_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    service
      .from("creative_runs")
      .select("*")
      .eq("parent_run_id", root.id)
      .contains("metadata", { domain_kind: "coop_game_concept" })
      .order("created_at", { ascending: true }),
    generationIds.length
      ? service.from("generations").select("*").in("id", generationIds)
      : Promise.resolve({ data: [], error: null }),
    service
      .from("gameplay_reference_reviews")
      .select("*")
      .eq("root_creative_run_id", root.id)
      .order("created_at", { ascending: true }),
  ]);

  if (jobResult.error) throw new Error(`Failed to load discovery factory job: ${jobResult.error.message}`);
  if (conceptsResult.error) throw new Error(`Failed to load discovery concepts: ${conceptsResult.error.message}`);
  if (generationsResult.error) throw new Error(`Failed to load reference generations: ${generationsResult.error.message}`);
  if (reviewsResult.error) throw new Error(`Failed to load reference reviews: ${reviewsResult.error.message}`);

  return {
    root,
    factoryJob: jobResult.data as Record<string, unknown> | null,
    conceptRuns: (conceptsResult.data ?? []) as Array<Record<string, unknown>>,
    referenceGenerations: (generationsResult.data ?? []) as Array<Record<string, unknown>>,
    reviews: (reviewsResult.data ?? []) as GameplayReferenceReview[],
  };
}

export async function listGameplayReferenceReviews(input: {
  userId: string;
  rootRunId: string;
}): Promise<GameplayReferenceReview[]> {
  const root = await getGameDiscoveryBatch({ userId: input.userId, runId: input.rootRunId });
  if (!root) throw new Error("FORBIDDEN");

  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("gameplay_reference_reviews")
    .select("*")
    .eq("root_creative_run_id", input.rootRunId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to list gameplay reference reviews: ${error.message}`);
  return (data ?? []) as GameplayReferenceReview[];
}

export async function recordGameplayReferenceReview(input: {
  userId: string;
  rootRunId: string;
  conceptRunId: string;
  generationId?: string | null;
  conceptId: string;
  momentId: string;
  shotId: string;
  decision: "approve" | "reject" | "revise";
  rawFeedback?: string | null;
}): Promise<GameplayReferenceReview> {
  const root = await getGameDiscoveryBatch({ userId: input.userId, runId: input.rootRunId });
  if (!root) throw new Error("FORBIDDEN");

  const service = createSupabaseServiceClient();
  const { data: conceptRun, error: conceptError } = await service
    .from("creative_runs")
    .select("id,parent_run_id,metadata,outputs")
    .eq("id", input.conceptRunId)
    .eq("parent_run_id", input.rootRunId)
    .maybeSingle();
  if (conceptError) throw new Error(`Failed to load concept run: ${conceptError.message}`);
  if (!conceptRun || conceptRun.metadata?.domain_kind !== "coop_game_concept") {
    throw new Error("CONCEPT_RUN_NOT_FOUND");
  }

  const rawFeedback = input.rawFeedback?.trim() ?? "";
  let structured;
  let model: string | null = null;
  let usage: Record<string, unknown> = {};

  if (rawFeedback) {
    const config = getKieConfig();
    if (!config.configured) throw new Error("KIE_NOT_CONFIGURED");
    const llm = new KieClaudeTaskAdapter(config.baseUrl, config.apiKey);
    const result = await structureGameplayReferenceFeedback({
      llm,
      rawFeedback,
      decision: input.decision,
      conceptSummary:
        typeof conceptRun.outputs?.coop_game_concept?.oneSentencePitch === "string"
          ? conceptRun.outputs.coop_game_concept.oneSentencePitch
          : input.conceptId,
      shotSummary:
        typeof conceptRun.outputs?.gameplay_shot?.action === "string"
          ? conceptRun.outputs.gameplay_shot.action
          : input.shotId,
    });
    structured = result.feedback;
    model = result.model;
    usage = result.usage;
  } else {
    structured = gameplayReferenceFeedbackV1Schema.parse({
      schema: "gameplay_reference_feedback",
      version: 1,
      errorTags: [],
      mustShow: [],
      mustAvoid: [],
      reusableScope: "shot",
      summary:
        input.decision === "approve"
          ? "Reference approved without additional feedback."
          : "Review decision recorded without additional written feedback.",
    });
  }

  const { data, error } = await service.rpc("orchestrator_record_gameplay_reference_review", {
    payload: {
      root_creative_run_id: input.rootRunId,
      concept_run_id: input.conceptRunId,
      generation_id: input.generationId ?? null,
      user_id: input.userId,
      concept_id: input.conceptId,
      moment_id: input.momentId,
      shot_id: input.shotId,
      decision: input.decision,
      raw_feedback: rawFeedback || null,
      structured_feedback: structured,
      model,
      usage,
    },
  });
  if (error) throw new Error(`Failed to record gameplay reference review: ${error.message}`);
  const review = rpcObject(rpcObject(data).review);
  if (typeof review.id !== "string") throw new Error("Invalid gameplay reference review response");
  return review as unknown as GameplayReferenceReview;
}
