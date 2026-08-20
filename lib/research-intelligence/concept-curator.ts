import type { CoopGameConceptSpecV1 } from "../game-discovery/schemas";
import { DurableWorkflowError } from "../orchestrator/retry";
import {
  curatedConceptBatchSpecV1Schema,
  curateConceptCandidates,
  type ConceptCuratorResult,
  type ConceptHypothesisSpecV1,
  type CuratedConceptBatchSpecV1,
} from "./concept-council";
import type { ConceptCouncilRepository } from "./concept-council-runtime";
import { evidencePackSpecV1Schema, type EvidencePackSpecV1 } from "./schemas";

export interface ConceptCouncilCuratorExecutionResultV1 extends ConceptCuratorResult {
  provider?: string | null;
  model?: string | null;
  usage?: Record<string, unknown>;
}

export interface ConceptCouncilCuratorExecutor {
  execute(input: {
    candidates: ConceptHypothesisSpecV1[];
    evidencePack: EvidencePackSpecV1;
    history?: CoopGameConceptSpecV1[];
    signal?: AbortSignal;
  }): Promise<ConceptCouncilCuratorExecutionResultV1>;
}

/**
 * Deterministic acceptance implementation. Production can replace this with one stronger
 * Curator model call while preserving the same typed 12 -> 6 contract and Diversity Guard.
 */
export class MockConceptCouncilCurator implements ConceptCouncilCuratorExecutor {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async execute(input: {
    candidates: ConceptHypothesisSpecV1[];
    evidencePack: EvidencePackSpecV1;
    history?: CoopGameConceptSpecV1[];
  }): Promise<ConceptCouncilCuratorExecutionResultV1> {
    const result = curateConceptCandidates({
      candidates: input.candidates,
      evidencePack: input.evidencePack,
      history: input.history,
      generatedAt: this.now().toISOString(),
    });
    return {
      ...result,
      provider: "mock",
      model: "deterministic-concept-curator-v1",
      usage: { model_calls: 1 },
    };
  }
}

export class ConceptCouncilCuratorService {
  constructor(
    private readonly repository: Pick<
      ConceptCouncilRepository,
      "getCuratedBatch" | "getFanoutStatus" | "persistCuratedBatch"
    >,
    private readonly executor: ConceptCouncilCuratorExecutor,
  ) {}

  async run(input: {
    researchRunId: string;
    evidencePack: EvidencePackSpecV1;
    history?: CoopGameConceptSpecV1[];
    signal?: AbortSignal;
  }): Promise<{
    batch: CuratedConceptBatchSpecV1;
    reusedFromPersistence: boolean;
    rawCandidateCount: number;
  }> {
    const pack = evidencePackSpecV1Schema.parse(input.evidencePack);
    if (pack.researchRunId !== input.researchRunId) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_CURATOR_PACK_LINEAGE_MISMATCH",
        message: "Curator Evidence Pack belongs to another ResearchRun",
        retryable: false,
      });
    }

    const existing = await this.repository.getCuratedBatch(input.researchRunId);
    if (existing) {
      if (existing.evidencePackId !== pack.packId) {
        throw new DurableWorkflowError({
          code: "CONCEPT_COUNCIL_CURATOR_STORED_PACK_MISMATCH",
          message: "Persisted Concept Council curation belongs to another Evidence Pack",
          retryable: false,
        });
      }
      return {
        batch: curatedConceptBatchSpecV1Schema.parse(existing),
        reusedFromPersistence: true,
        rawCandidateCount: existing.rawCandidateCount,
      };
    }

    const status = await this.repository.getFanoutStatus(input.researchRunId);
    if (status.evidencePackId !== pack.packId) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_CURATOR_FANOUT_PACK_MISMATCH",
        message: "Concept Designer fan-out belongs to another Evidence Pack",
        retryable: false,
      });
    }
    if (status.designerCount !== 3) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_CURATOR_DESIGNER_COUNT_INVALID",
        message: `Concept Curator requires exactly three durable Designers, got ${status.designerCount}`,
        retryable: false,
      });
    }
    if (!status.allTerminal) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_CURATOR_WAITING_DESIGNERS",
        message: "Concept Curator cannot run until all three Designers are terminal",
        retryable: true,
      });
    }
    if (status.failedCount > 0 || status.completedCount !== 3) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_CURATOR_DESIGNER_FAILED",
        message: "Concept Curator fails closed when any required Designer failed",
        retryable: false,
        details: { failed_count: status.failedCount, completed_count: status.completedCount },
      });
    }

    const outputs = status.items.map((item) => item.output);
    if (outputs.some((output) => output === null)) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_CURATOR_OUTPUT_MISSING",
        message: "A completed Concept Designer is missing its durably persisted output",
        retryable: false,
      });
    }
    const candidates = outputs.flatMap((output) => output!.candidates);
    if (candidates.length < 6 || candidates.length > 12) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_CURATOR_RAW_COUNT_INVALID",
        message: `Concept Curator requires 6-12 raw hypotheses, got ${candidates.length}`,
        retryable: false,
      });
    }

    const execution = await this.executor.execute({
      candidates,
      evidencePack: pack,
      history: input.history,
      signal: input.signal,
    });
    const batch = curatedConceptBatchSpecV1Schema.parse(execution.batch);
    if (
      batch.researchRunId !== input.researchRunId ||
      batch.evidencePackId !== pack.packId ||
      batch.rawCandidateCount !== candidates.length
    ) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_CURATOR_OUTPUT_LINEAGE_MISMATCH",
        message: "Concept Curator returned a batch for another durable input",
        retryable: false,
      });
    }

    const persisted = await this.repository.persistCuratedBatch({
      researchRunId: input.researchRunId,
      batch,
      metadata: {
        provider: execution.provider ?? null,
        model: execution.model ?? null,
        usage: execution.usage ?? {},
        rejected_candidates: execution.rejected,
        curator_call_budget: 1,
      },
    });

    return {
      batch: persisted.batch,
      reusedFromPersistence: persisted.duplicate,
      rawCandidateCount: candidates.length,
    };
  }
}
