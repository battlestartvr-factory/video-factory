import { DurableWorkflowError } from "../orchestrator/retry";
import { requireRpcObject, type OrchestratorRpcClient } from "../orchestrator/rpc";
import { discoveryObjectiveSpecV1Schema, type DiscoveryObjectiveSpecV1 } from "../game-discovery/schemas";
import {
  conceptCouncilDesignerRoleSchema,
  conceptDesignerOutputSpecV1Schema,
  curatedConceptBatchSpecV1Schema,
  type ConceptCouncilDesignerRoleV1,
  type ConceptDesignerOutputSpecV1,
  type CuratedConceptBatchSpecV1,
} from "./concept-council";
import { evidencePackSpecV1Schema, type EvidencePackSpecV1 } from "./schemas";

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

export interface ConceptCouncilChild {
  designerRole: ConceptCouncilDesignerRoleV1;
  factoryJobId: string;
  creativeRunId: string;
  duplicate: boolean;
  queueMsgId: number | null;
}

export interface ConceptCouncilFanout {
  researchRunId: string;
  evidencePackId: string;
  status: "waiting_designers";
  designers: ConceptCouncilChild[];
}

export interface ConceptCouncilMemberJobContext {
  researchRunId: string;
  evidencePackId: string;
  designerRole: ConceptCouncilDesignerRoleV1;
  objective: DiscoveryObjectiveSpecV1;
  evidencePack: EvidencePackSpecV1;
  creativeRunId: string;
  rootFactoryJobId: string;
  rootCreativeRunId: string;
  existingOutput: ConceptDesignerOutputSpecV1 | null;
}

export interface ConceptCouncilFanoutItem {
  designerRole: ConceptCouncilDesignerRoleV1;
  factoryJobId: string;
  creativeRunId: string;
  jobStatus: string;
  retryCount: number;
  error: Record<string, unknown> | null;
  output: ConceptDesignerOutputSpecV1 | null;
}

export interface ConceptCouncilFanoutStatus {
  researchRunId: string;
  evidencePackId: string;
  designerCount: number;
  terminalCount: number;
  completedCount: number;
  failedCount: number;
  allTerminal: boolean;
  items: ConceptCouncilFanoutItem[];
}

function parseChild(value: unknown): ConceptCouncilChild | null {
  const row = object(value);
  const parsedRole = conceptCouncilDesignerRoleSchema.safeParse(row.designer_role);
  const factoryJobId = text(row.factory_job_id);
  const creativeRunId = text(row.creative_run_id);
  if (!parsedRole.success || !factoryJobId || !creativeRunId) return null;
  return {
    designerRole: parsedRole.data,
    factoryJobId,
    creativeRunId,
    duplicate: row.duplicate === true,
    queueMsgId: typeof row.queue_msg_id === "number" ? row.queue_msg_id : null,
  };
}

function parseOutput(value: unknown): ConceptDesignerOutputSpecV1 | null {
  if (value === null || value === undefined) return null;
  const parsed = conceptDesignerOutputSpecV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export class ConceptCouncilRepository {
  constructor(private readonly client: OrchestratorRpcClient) {}

  async fanOut(input: {
    researchRunId: string;
    evidencePackId: string;
    objective: DiscoveryObjectiveSpecV1;
  }): Promise<ConceptCouncilFanout> {
    const objective = discoveryObjectiveSpecV1Schema.parse(input.objective);
    const { data, error } = await this.client.rpc("concept_council_fanout", {
      payload: {
        research_run_id: input.researchRunId,
        evidence_pack_id: input.evidencePackId,
        objective,
      },
    });
    if (error) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_FANOUT_FAILED",
        message: `Failed to create Concept Council fan-out: ${error.message}`,
        retryable: true,
      });
    }
    const row = requireRpcObject(data, "concept_council_fanout");
    const researchRunId = text(row.research_run_id);
    const evidencePackId = text(row.evidence_pack_id);
    const designers = array(row.designers)
      .map(parseChild)
      .filter((item): item is ConceptCouncilChild => item !== null);
    if (!researchRunId || !evidencePackId || row.status !== "waiting_designers" || designers.length !== 3) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_FANOUT_INVALID",
        message: "Concept Council returned an invalid three-designer fan-out",
        retryable: false,
      });
    }
    return { researchRunId, evidencePackId, status: "waiting_designers", designers };
  }

  async beginMemberJob(jobId: string): Promise<ConceptCouncilMemberJobContext> {
    const { data, error } = await this.client.rpc("concept_council_begin_member_job", { p_job_id: jobId });
    if (error) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_CONTEXT_FAILED",
        message: `Failed to load Concept Council member context: ${error.message}`,
        retryable: true,
      });
    }
    const row = requireRpcObject(data, "concept_council_begin_member_job");
    const researchRunId = text(row.research_run_id);
    const evidencePackId = text(row.evidence_pack_id);
    const creativeRunId = text(row.creative_run_id);
    const rootFactoryJobId = text(row.root_factory_job_id);
    const rootCreativeRunId = text(row.root_creative_run_id);
    const role = conceptCouncilDesignerRoleSchema.safeParse(row.designer_role);
    const objective = discoveryObjectiveSpecV1Schema.safeParse(row.objective);
    const pack = evidencePackSpecV1Schema.safeParse(row.evidence_pack);
    if (
      !researchRunId ||
      !evidencePackId ||
      !creativeRunId ||
      !rootFactoryJobId ||
      !rootCreativeRunId ||
      !role.success ||
      !objective.success ||
      !pack.success
    ) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_CONTEXT_INVALID",
        message: "Durable Concept Council member context is invalid",
        retryable: false,
      });
    }
    if (pack.data.researchRunId !== researchRunId || pack.data.packId !== evidencePackId) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_PACK_LINEAGE_MISMATCH",
        message: "Durable Evidence Pack does not match Concept Council assignment",
        retryable: false,
      });
    }
    const existingOutput = parseOutput(row.existing_output);
    if (row.existing_output != null && !existingOutput) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_STORED_OUTPUT_INVALID",
        message: "Stored Concept Council member output does not match the v1 schema",
        retryable: false,
      });
    }
    return {
      researchRunId,
      evidencePackId,
      designerRole: role.data,
      objective: objective.data,
      evidencePack: pack.data,
      creativeRunId,
      rootFactoryJobId,
      rootCreativeRunId,
      existingOutput,
    };
  }

  async persistMemberOutput(input: {
    jobId: string;
    output: ConceptDesignerOutputSpecV1;
    provider?: string | null;
    model?: string | null;
    usage?: Record<string, unknown>;
  }): Promise<{ duplicate: boolean; output: ConceptDesignerOutputSpecV1 }> {
    const output = conceptDesignerOutputSpecV1Schema.parse(input.output);
    const { data, error } = await this.client.rpc("concept_council_persist_member_output", {
      payload: {
        job_id: input.jobId,
        output,
        provider: input.provider ?? null,
        model: input.model ?? null,
        usage: input.usage ?? {},
      },
    });
    if (error) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_OUTPUT_PERSIST_FAILED",
        message: `Failed to persist Concept Council member output: ${error.message}`,
        retryable: true,
      });
    }
    const row = requireRpcObject(data, "concept_council_persist_member_output");
    const stored = conceptDesignerOutputSpecV1Schema.safeParse(row.output);
    if (row.persisted !== true || !stored.success) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_OUTPUT_PERSIST_INVALID",
        message: "Persisted Concept Council output response is invalid",
        retryable: false,
      });
    }
    return { duplicate: row.duplicate === true, output: stored.data };
  }

  async getFanoutStatus(researchRunId: string): Promise<ConceptCouncilFanoutStatus> {
    const { data, error } = await this.client.rpc("concept_council_get_fanout_status", {
      p_research_run_id: researchRunId,
    });
    if (error) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_STATUS_FAILED",
        message: `Failed to inspect Concept Council fan-out: ${error.message}`,
        retryable: true,
      });
    }
    const row = requireRpcObject(data, "concept_council_get_fanout_status");
    const id = text(row.research_run_id);
    const evidencePackId = text(row.evidence_pack_id);
    if (!id || !evidencePackId) throw new Error("Invalid Concept Council fan-out status response");
    const items = array(row.items)
      .map((value) => {
        const item = object(value);
        const role = conceptCouncilDesignerRoleSchema.safeParse(item.designer_role);
        const factoryJobId = text(item.factory_job_id);
        const creativeRunId = text(item.creative_run_id);
        const jobStatus = text(item.job_status);
        if (!role.success || !factoryJobId || !creativeRunId || !jobStatus) return null;
        return {
          designerRole: role.data,
          factoryJobId,
          creativeRunId,
          jobStatus,
          retryCount: typeof item.retry_count === "number" ? item.retry_count : 0,
          error:
            item.error && typeof item.error === "object" && !Array.isArray(item.error)
              ? (item.error as Record<string, unknown>)
              : null,
          output: parseOutput(item.output),
        } satisfies ConceptCouncilFanoutItem;
      })
      .filter((item): item is ConceptCouncilFanoutItem => item !== null);
    return {
      researchRunId: id,
      evidencePackId,
      designerCount: typeof row.designer_count === "number" ? row.designer_count : items.length,
      terminalCount: typeof row.terminal_count === "number" ? row.terminal_count : 0,
      completedCount: typeof row.completed_count === "number" ? row.completed_count : 0,
      failedCount: typeof row.failed_count === "number" ? row.failed_count : 0,
      allTerminal: row.all_terminal === true,
      items,
    };
  }

  async getCuratedBatch(researchRunId: string): Promise<CuratedConceptBatchSpecV1 | null> {
    const { data, error } = await this.client.rpc("concept_council_get_curated_batch", {
      p_research_run_id: researchRunId,
    });
    if (error) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_CURATED_LOAD_FAILED",
        message: `Failed to load curated Concept Council batch: ${error.message}`,
        retryable: true,
      });
    }
    if (data === null || data === undefined) return null;
    const row = requireRpcObject(data, "concept_council_get_curated_batch");
    if (row.batch === null || row.batch === undefined) return null;
    const parsed = curatedConceptBatchSpecV1Schema.safeParse(row.batch);
    if (!parsed.success) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_CURATED_STORED_INVALID",
        message: "Stored curated Concept Council batch is invalid",
        retryable: false,
      });
    }
    return parsed.data;
  }

  async persistCuratedBatch(input: {
    researchRunId: string;
    batch: CuratedConceptBatchSpecV1;
    metadata?: Record<string, unknown>;
  }): Promise<{ duplicate: boolean; batch: CuratedConceptBatchSpecV1 }> {
    const batch = curatedConceptBatchSpecV1Schema.parse(input.batch);
    if (batch.researchRunId !== input.researchRunId) {
      throw new Error("Concept Council curated batch researchRunId mismatch");
    }
    const { data, error } = await this.client.rpc("concept_council_persist_curated_batch", {
      payload: {
        research_run_id: input.researchRunId,
        batch,
        metadata: input.metadata ?? {},
      },
    });
    if (error) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_CURATED_PERSIST_FAILED",
        message: `Failed to persist curated Concept Council batch: ${error.message}`,
        retryable: true,
      });
    }
    const row = requireRpcObject(data, "concept_council_persist_curated_batch");
    const stored = curatedConceptBatchSpecV1Schema.safeParse(row.batch);
    if (row.persisted !== true || !stored.success) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_CURATED_PERSIST_INVALID",
        message: "Persisted curated Concept Council batch response is invalid",
        retryable: false,
      });
    }
    return { duplicate: row.duplicate === true, batch: stored.data };
  }
}
