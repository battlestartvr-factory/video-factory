import type { OrchestratorRpcClient } from "../orchestrator/rpc";
import { requireRpcObject } from "../orchestrator/rpc";
import {
  bundleForRpc,
  researchScoutEvidenceBundleV1Schema,
  researchSha256,
  type PersistedScoutEvidenceBundleV1,
  type ResearchScoutEvidenceBundleV1,
} from "./evidence-bundle";
import {
  evidencePackSpecV1Schema,
  researchEvidenceSpecV1Schema,
  researchScoutReportSpecV1Schema,
  researchScoutRoleSchema,
  type EvidencePackSpecV1,
  type ResearchEvidenceSpecV1,
  type ResearchScoutReportSpecV1,
  type ResearchScoutRoleV1,
} from "./schemas";
import type {
  ResearchSynthesisInputV1,
  ResearchSynthesisRepository,
  ResearchScoutSynthesisStatusV1,
} from "./synthesis";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringMap(value: unknown): Record<string, string> {
  const row = object(value);
  return Object.fromEntries(
    Object.entries(row).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function parseEvidenceArray(value: unknown): ResearchEvidenceSpecV1[] {
  return array(value).map((item) => researchEvidenceSpecV1Schema.parse(item));
}

function parseScoutStatuses(value: unknown): ResearchScoutSynthesisStatusV1[] {
  return array(value).map((item) => {
    const row = object(item);
    const role = researchScoutRoleSchema.parse(row.scout_role);
    const status = typeof row.status === "string" ? row.status : "unknown";
    const report = row.report ? researchScoutReportSpecV1Schema.parse(row.report) : null;
    return { scoutRole: role, status, report };
  });
}

export class ResearchIntelligenceRepository implements ResearchSynthesisRepository {
  constructor(private readonly client: OrchestratorRpcClient) {}

  async persistScoutEvidenceBundle(input: {
    jobId: string;
    bundle: ResearchScoutEvidenceBundleV1;
  }): Promise<PersistedScoutEvidenceBundleV1> {
    const bundle = researchScoutEvidenceBundleV1Schema.parse(input.bundle);
    const rpcBundle = bundleForRpc(bundle);
    const bundleHash = researchSha256(rpcBundle);
    const { data, error } = await this.client.rpc("research_persist_scout_evidence_bundle", {
      payload: {
        job_id: input.jobId,
        bundle_hash: bundleHash,
        bundle: rpcBundle,
      },
    });
    if (error) throw new Error(`Failed to persist Scout evidence bundle: ${error.message}`);
    const row = requireRpcObject(data, "Scout evidence bundle persistence");
    const returnedHash = typeof row.bundle_hash === "string" ? row.bundle_hash : bundleHash;
    if (returnedHash !== bundleHash) {
      throw new Error("Scout evidence persistence returned a mismatched bundle hash");
    }
    return {
      duplicate: row.duplicate === true,
      bundleHash,
      sourceIdsByRef: stringMap(row.source_ids_by_ref),
      evidenceIdsByRef: stringMap(row.evidence_ids_by_ref),
      evidence: parseEvidenceArray(row.evidence),
    };
  }

  async loadSynthesisInput(researchRunId: string): Promise<ResearchSynthesisInputV1> {
    const { data, error } = await this.client.rpc("research_get_synthesis_input", {
      p_research_run_id: researchRunId,
    });
    if (error) throw new Error(`Failed to load research synthesis input: ${error.message}`);
    const row = requireRpcObject(data, "research synthesis input");
    const returnedRunId = typeof row.research_run_id === "string" ? row.research_run_id : "";
    const objectiveId = typeof row.objective_id === "string" ? row.objective_id : "";
    if (!returnedRunId || !objectiveId) throw new Error("Invalid research synthesis input identity");

    return {
      researchRunId: returnedRunId,
      objectiveId,
      scoutStatuses: parseScoutStatuses(row.scout_statuses),
      evidence: parseEvidenceArray(row.evidence),
      knownSourceIds: array(row.known_source_ids).filter((item): item is string => typeof item === "string"),
      knownImageReferenceIds: array(row.known_image_reference_ids).filter(
        (item): item is string => typeof item === "string",
      ),
      activePack: row.active_pack ? evidencePackSpecV1Schema.parse(row.active_pack) : null,
    };
  }

  async persistEvidencePack(input: {
    researchRunId: string;
    inputHash: string;
    pack: EvidencePackSpecV1;
    metadata?: Record<string, unknown>;
  }): Promise<{ duplicate: boolean; pack: EvidencePackSpecV1 }> {
    const pack = evidencePackSpecV1Schema.parse(input.pack);
    const { data, error } = await this.client.rpc("research_persist_evidence_pack", {
      payload: {
        research_run_id: input.researchRunId,
        input_hash: input.inputHash,
        pack,
        metadata: input.metadata ?? {},
      },
    });
    if (error) throw new Error(`Failed to persist Evidence Pack: ${error.message}`);
    const row = requireRpcObject(data, "Evidence Pack persistence");
    return {
      duplicate: row.duplicate === true,
      pack: evidencePackSpecV1Schema.parse(row.pack ?? pack),
    };
  }
}

export type {
  EvidencePackSpecV1,
  ResearchEvidenceSpecV1,
  ResearchScoutReportSpecV1,
  ResearchScoutRoleV1,
};
