import "server-only";

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getGameDiscoveryBatch } from "./service";

export interface EarlyFinalizeResearchResult {
  accepted: boolean;
  duplicate: boolean;
  rootJobId: string;
  researchRunId: string;
  cancelledScouts: number;
  finalization: "early_finalized";
  reason?: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function earlyFinalizeGameDiscoveryResearch(input: {
  userId: string;
  runId: string;
}): Promise<EarlyFinalizeResearchResult | null> {
  const root = await getGameDiscoveryBatch({ userId: input.userId, runId: input.runId });
  if (!root || !root.factory_job_id) return null;

  const service = createSupabaseServiceClient();
  const { data, error } = await service.rpc("orchestrator_request_research_early_finalize", {
    p_root_job_id: root.factory_job_id,
    p_user_id: input.userId,
  });
  if (error) throw new Error(`Failed to early-finalize Game Discovery research: ${error.message}`);

  const row = object(data);
  if (row.accepted !== true) {
    return {
      accepted: false,
      duplicate: false,
      rootJobId: root.factory_job_id,
      researchRunId: typeof row.research_run_id === "string" ? row.research_run_id : "",
      cancelledScouts: 0,
      finalization: "early_finalized",
      reason: typeof row.reason === "string" ? row.reason : "not_eligible",
    };
  }
  if (typeof row.root_job_id !== "string" || typeof row.research_run_id !== "string") {
    throw new Error("Invalid orchestrator_request_research_early_finalize response");
  }

  return {
    accepted: true,
    duplicate: row.duplicate === true,
    rootJobId: row.root_job_id,
    researchRunId: row.research_run_id,
    cancelledScouts: count(row.cancelled_scouts),
    finalization: "early_finalized",
  };
}
