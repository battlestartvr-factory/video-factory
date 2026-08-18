import type { OrchestratorRpcClient } from "../orchestrator/rpc";
import { requireRpcObject } from "../orchestrator/rpc";
import {
  conceptPreEvaluationV1Schema,
  coopGameConceptSpecV1Schema,
  gameplayMomentSpecV1Schema,
  type ConceptPreEvaluationV1,
  type CoopGameConceptSpecV1,
  type GameplayMomentSpecV1,
} from "./schemas";
import type { ConceptExplorerResult } from "./concept-explorer";
import type { ConceptPreEvaluationResult } from "./pre-evaluator";
import type { GameplayMomentPlanningResult } from "./moment-planner";

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

function parseConceptRuns(value: unknown): PersistedConceptRun[] {
  return array(value)
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      return typeof record.run_id === "string" && typeof record.concept_id === "string"
        ? { runId: record.run_id, conceptId: record.concept_id }
        : null;
    })
    .filter((item): item is PersistedConceptRun => item !== null);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
      selectedConceptIds: array(row.selected_concept_ids).filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
      moments: array(row.gameplay_moments)
        .map((value) => gameplayMomentSpecV1Schema.safeParse(value))
        .filter((parsed) => parsed.success)
        .map((parsed) => parsed.data),
      preEvaluationMetadata: object(row.pre_evaluation_metadata),
      momentPlannerMetadata: object(row.moment_planner_metadata),
    };
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
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const concept = (item as Record<string, unknown>).concept;
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
}
