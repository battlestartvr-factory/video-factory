import type { OrchestratorRpcClient } from "../orchestrator/rpc";
import { requireRpcObject } from "../orchestrator/rpc";
import {
  conceptPreEvaluationV1Schema,
  coopGameConceptSpecV1Schema,
  gameplayMomentSpecV1Schema,
  promptPlanV1Schema,
  shotSpecV1Schema,
  type ConceptPreEvaluationV1,
  type CoopGameConceptSpecV1,
  type GameplayMomentSpecV1,
  type PromptPlanV1,
  type ShotSpecV1,
} from "./schemas";
import type { ConceptExplorerResult } from "./concept-explorer";
import type { ConceptPreEvaluationResult } from "./pre-evaluator";
import type { GameplayMomentPlanningResult } from "./moment-planner";
import type { DiscoveryFeedbackMemory, ShotPlanningResult } from "./shot-planner";

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): string[] {
  return array(value).filter((item): item is string => typeof item === "string" && item.length > 0);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface PersistedConceptRun {
  runId: string;
  conceptId: string;
}

export interface PersistedConceptStage {
  persisted: boolean;
  acceptedConcepts: CoopGameConceptSpecV1[];
  conceptRuns: PersistedConceptRun[];
  explorerMetadata: Record<string, unknown>;
  rejectionCount: number;
}

export interface PersistedPlanningStage {
  preEvaluations: ConceptPreEvaluationV1[];
  selectedConceptIds: string[];
  moments: GameplayMomentSpecV1[];
  preEvaluationMetadata: Record<string, unknown>;
  momentPlannerMetadata: Record<string, unknown>;
}

export interface PersistedVisualStage {
  shots: ShotSpecV1[];
  promptPlans: PromptPlanV1[];
  shotPlannerMetadata: Record<string, unknown>;
  promptCompilerMetadata: Record<string, unknown>;
  referenceApprovalRequired: boolean;
}

export interface ReferenceImageStageItem {
  shotId: string;
  conceptId: string;
  momentId: string;
  conceptRunId: string;
  generationId: string;
  factoryJobId: string;
  status: string;
  outputs: Array<Record<string, unknown>>;
  errorMessage: string | null;
  modelId: string | null;
}

export interface ReferenceImageStage {
  items: ReferenceImageStageItem[];
  requestCount: number;
  allTerminal: boolean;
  allCompleted: boolean;
}

export interface ReferenceApprovalItem extends ReferenceImageStageItem {
  decision: "approve" | "reject" | "revise" | null;
  reviewId: string | null;
  rawFeedback: string | null;
  structuredFeedback: Record<string, unknown>;
}

export interface ReferenceApprovalStage {
  items: ReferenceApprovalItem[];
  allReviewed: boolean;
  allApproved: boolean;
}

function parseConceptRuns(value: unknown): PersistedConceptRun[] {
  return array(value)
    .map((item) => {
      const record = object(item);
      return typeof record.run_id === "string" && typeof record.concept_id === "string"
        ? { runId: record.run_id, conceptId: record.concept_id }
        : null;
    })
    .filter((item): item is PersistedConceptRun => item !== null);
}

function parseReferenceItem(value: unknown, approval = false): ReferenceImageStageItem | ReferenceApprovalItem | null {
  const row = object(value);
  const shotId = text(row.shot_id);
  const conceptId = text(row.concept_id);
  const momentId = text(row.moment_id);
  const conceptRunId = text(row.concept_run_id);
  const generationId = text(row.generation_id);
  const factoryJobId = text(row.factory_job_id) ?? "";
  const status = text(approval ? row.generation_status : row.status);
  if (!shotId || !conceptId || !momentId || !conceptRunId || !generationId || !status) return null;

  const base: ReferenceImageStageItem = {
    shotId,
    conceptId,
    momentId,
    conceptRunId,
    generationId,
    factoryJobId,
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

export class GameDiscoveryWorkerRepository {
  constructor(private readonly client: OrchestratorRpcClient) {}

  async getConceptStage(input: { rootCreativeRunId: string }): Promise<PersistedConceptStage> {
    const { data, error } = await this.client.rpc("orchestrator_get_game_discovery_concept_stage", {
      payload: { root_creative_run_id: input.rootCreativeRunId },
    });
    if (error) throw new Error(`Failed to inspect game discovery concept stage: ${error.message}`);

    const row = requireRpcObject(data, "game discovery concept stage");
    const acceptedConcepts = array(row.accepted_concepts)
      .map((concept) => coopGameConceptSpecV1Schema.safeParse(concept))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data);

    return {
      persisted: row.persisted === true,
      acceptedConcepts,
      conceptRuns: parseConceptRuns(row.concept_runs),
      explorerMetadata: object(row.concept_explorer),
      rejectionCount: array(row.diversity_rejections).length,
    };
  }

  async getPlanningStage(input: { rootCreativeRunId: string }): Promise<PersistedPlanningStage> {
    const { data, error } = await this.client.rpc("orchestrator_get_game_discovery_planning_stage", {
      payload: { root_creative_run_id: input.rootCreativeRunId },
    });
    if (error) throw new Error(`Failed to inspect game discovery planning stage: ${error.message}`);

    const row = requireRpcObject(data, "game discovery planning stage");
    return {
      preEvaluations: array(row.pre_evaluations)
        .map((value) => conceptPreEvaluationV1Schema.safeParse(value))
        .filter((parsed) => parsed.success)
        .map((parsed) => parsed.data),
      selectedConceptIds: strings(row.selected_concept_ids),
      moments: array(row.gameplay_moments)
        .map((value) => gameplayMomentSpecV1Schema.safeParse(value))
        .filter((parsed) => parsed.success)
        .map((parsed) => parsed.data),
      preEvaluationMetadata: object(row.pre_evaluation_metadata),
      momentPlannerMetadata: object(row.moment_planner_metadata),
    };
  }

  async getVisualStage(input: { rootCreativeRunId: string }): Promise<PersistedVisualStage> {
    const { data, error } = await this.client.rpc("orchestrator_get_game_discovery_visual_stage", {
      payload: { root_creative_run_id: input.rootCreativeRunId },
    });
    if (error) throw new Error(`Failed to inspect game discovery visual stage: ${error.message}`);

    const row = requireRpcObject(data, "game discovery visual stage");
    return {
      shots: array(row.gameplay_shots)
        .map((value) => shotSpecV1Schema.safeParse(value))
        .filter((parsed) => parsed.success)
        .map((parsed) => parsed.data),
      promptPlans: array(row.prompt_plans)
        .map((value) => promptPlanV1Schema.safeParse(value))
        .filter((parsed) => parsed.success)
        .map((parsed) => parsed.data),
      shotPlannerMetadata: object(row.shot_planner_metadata),
      promptCompilerMetadata: object(row.prompt_compiler_metadata),
      referenceApprovalRequired: row.reference_approval_required === true,
    };
  }

  async createReferenceImage(input: {
    rootJobId: string;
    rootCreativeRunId: string;
    requestId: string;
    conceptId: string;
    momentId: string;
    shotId: string;
    prompt: string;
    modelId?: string;
  }): Promise<{ generationId: string; factoryJobId: string; duplicate: boolean }> {
    const { data, error } = await this.client.rpc("orchestrator_create_gameplay_reference_image", {
      payload: {
        root_job_id: input.rootJobId,
        root_creative_run_id: input.rootCreativeRunId,
        request_id: input.requestId,
        concept_id: input.conceptId,
        moment_id: input.momentId,
        shot_id: input.shotId,
        prompt: input.prompt,
        model_id: input.modelId ?? "nano-banana-2",
        settings: { aspectRatio: "9:16", effectiveQuality: "1K" },
      },
    });
    if (error) throw new Error(`Failed to admit gameplay reference image: ${error.message}`);
    const row = requireRpcObject(data, "gameplay reference image admission");
    const generation = object(row.generation);
    if (typeof generation.id !== "string" || typeof row.factory_job_id !== "string") {
      throw new Error("Invalid gameplay reference image admission response");
    }
    return {
      generationId: generation.id,
      factoryJobId: row.factory_job_id,
      duplicate: row.duplicate === true,
    };
  }

  async getReferenceImageStage(input: { rootCreativeRunId: string }): Promise<ReferenceImageStage> {
    const { data, error } = await this.client.rpc("orchestrator_get_gameplay_reference_image_stage", {
      payload: { root_creative_run_id: input.rootCreativeRunId },
    });
    if (error) throw new Error(`Failed to inspect gameplay reference images: ${error.message}`);
    const row = requireRpcObject(data, "gameplay reference image stage");
    return {
      items: array(row.items)
        .map((item) => parseReferenceItem(item))
        .filter((item): item is ReferenceImageStageItem => item !== null),
      requestCount: typeof row.request_count === "number" ? row.request_count : 0,
      allTerminal: row.all_terminal === true,
      allCompleted: row.all_completed === true,
    };
  }

  async getReferenceApprovalStage(input: {
    rootCreativeRunId: string;
  }): Promise<ReferenceApprovalStage> {
    const { data, error } = await this.client.rpc("orchestrator_get_gameplay_reference_approval_stage", {
      payload: { root_creative_run_id: input.rootCreativeRunId },
    });
    if (error) throw new Error(`Failed to inspect gameplay reference approvals: ${error.message}`);
    const row = requireRpcObject(data, "gameplay reference approval stage");
    return {
      items: array(row.items)
        .map((item) => parseReferenceItem(item, true))
        .filter((item): item is ReferenceApprovalItem => item !== null),
      allReviewed: row.all_reviewed === true,
      allApproved: row.all_approved === true,
    };
  }

  async getFeedbackMemory(input: { rootCreativeRunId: string }): Promise<DiscoveryFeedbackMemory> {
    const { data, error } = await this.client.rpc("orchestrator_get_game_discovery_feedback_memory", {
      payload: { root_creative_run_id: input.rootCreativeRunId },
    });
    if (error) throw new Error(`Failed to load game discovery feedback memory: ${error.message}`);

    const row = requireRpcObject(data, "game discovery feedback memory");
    const mustShow = new Set<string>();
    const mustAvoid = new Set<string>();
    const errorTags = new Set<string>();
    for (const item of array(row.items)) {
      const record = object(item);
      strings(record.must_show).forEach((value) => mustShow.add(value));
      strings(record.must_avoid).forEach((value) => mustAvoid.add(value));
      strings(record.error_tags).forEach((value) => errorTags.add(value));
    }
    return { mustShow: [...mustShow], mustAvoid: [...mustAvoid], errorTags: [...errorTags] };
  }

  async getConceptHistory(input: {
    rootCreativeRunId: string;
    limit?: number;
  }): Promise<CoopGameConceptSpecV1[]> {
    const { data, error } = await this.client.rpc("orchestrator_get_game_concept_history", {
      payload: {
        root_creative_run_id: input.rootCreativeRunId,
        limit: Math.min(Math.max(input.limit ?? 200, 1), 200),
      },
    });
    if (error) throw new Error(`Failed to load game concept history: ${error.message}`);

    const row = requireRpcObject(data, "game concept history");
    const concepts: CoopGameConceptSpecV1[] = [];
    for (const item of array(row.items)) {
      const concept = object(item).concept;
      const parsed = coopGameConceptSpecV1Schema.safeParse(concept);
      if (parsed.success) concepts.push(parsed.data);
    }
    return concepts;
  }

  async persistConceptExploration(input: {
    jobId: string;
    rootCreativeRunId: string;
    result: ConceptExplorerResult;
  }): Promise<PersistedConceptRun[]> {
    const { data, error } = await this.client.rpc("orchestrator_persist_game_concept_exploration", {
      payload: {
        job_id: input.jobId,
        root_creative_run_id: input.rootCreativeRunId,
        accepted_concepts: input.result.accepted,
        rejections: input.result.rejected,
        model: input.result.model,
        explorer_metadata: {
          requested_count: input.result.requestedCount,
          generated_count: input.result.generatedCount,
          replacement_attempts: input.result.replacementAttempts,
          raw_response_hashes: input.result.rawResponseHashes,
          usage: input.result.usage,
        },
      },
    });
    if (error) throw new Error(`Failed to persist concept exploration: ${error.message}`);

    const row = requireRpcObject(data, "persist game concept exploration");
    return parseConceptRuns(row.concept_runs);
  }

  async persistPreEvaluations(input: {
    jobId: string;
    rootCreativeRunId: string;
    result: ConceptPreEvaluationResult;
    selectedConceptIds: string[];
  }): Promise<void> {
    const { error } = await this.client.rpc("orchestrator_persist_game_pre_evaluations", {
      payload: {
        job_id: input.jobId,
        root_creative_run_id: input.rootCreativeRunId,
        evaluations: input.result.evaluations,
        selected_concept_ids: input.selectedConceptIds,
        model: input.result.model,
        metadata: {
          raw_response_hashes: input.result.rawResponseHashes,
          usage: input.result.usage,
          passing_concept_ids: input.result.passingConceptIds,
          selection_policy: "first_passing_in_explorer_order_v1",
        },
      },
    });
    if (error) throw new Error(`Failed to persist concept pre-evaluations: ${error.message}`);
  }

  async persistGameplayMoments(input: {
    jobId: string;
    rootCreativeRunId: string;
    result: GameplayMomentPlanningResult;
  }): Promise<void> {
    const { error } = await this.client.rpc("orchestrator_persist_gameplay_moments", {
      payload: {
        job_id: input.jobId,
        root_creative_run_id: input.rootCreativeRunId,
        moments: input.result.moments,
        model: input.result.model,
        metadata: {
          raw_response_hashes: input.result.rawResponseHashes,
          usage: input.result.usage,
        },
      },
    });
    if (error) throw new Error(`Failed to persist gameplay moments: ${error.message}`);
  }

  async persistShotsAndPrompts(input: {
    jobId: string;
    rootCreativeRunId: string;
    result: ShotPlanningResult;
    promptPlans: PromptPlanV1[];
  }): Promise<void> {
    const { error } = await this.client.rpc("orchestrator_persist_gameplay_shots_and_prompts", {
      payload: {
        job_id: input.jobId,
        root_creative_run_id: input.rootCreativeRunId,
        shots: input.result.shots,
        prompt_plans: input.promptPlans,
        shot_planner_metadata: {
          model: input.result.model,
          repair_model: input.result.repairModel,
          escalated: input.result.escalated,
          raw_response_hashes: input.result.rawResponseHashes,
          usage: input.result.usage,
        },
        prompt_compiler_metadata: {
          compiler: "gameplay_prompt_compiler_v1",
          llm_calls: 0,
          reference_approval_required: true,
        },
      },
    });
    if (error) throw new Error(`Failed to persist gameplay shots/prompts: ${error.message}`);
  }
}
