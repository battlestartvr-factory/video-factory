import type { OrchestratorRpcClient } from "../orchestrator/rpc";
import { requireRpcObject } from "../orchestrator/rpc";
import {
  coopGameConceptSpecV1Schema,
  type CoopGameConceptSpecV1,
} from "./schemas";
import type { ConceptExplorerResult } from "./concept-explorer";

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export interface PersistedConceptRun {
  runId: string;
  conceptId: string;
}

export class GameDiscoveryWorkerRepository {
  constructor(private readonly client: OrchestratorRpcClient) {}

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
    return array(row.concept_runs)
      .map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const record = item as Record<string, unknown>;
        return typeof record.run_id === "string" && typeof record.concept_id === "string"
          ? { runId: record.run_id, conceptId: record.concept_id }
          : null;
      })
      .filter((item): item is PersistedConceptRun => item !== null);
  }
}
