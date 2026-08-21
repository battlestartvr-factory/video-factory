import "server-only";

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getGameDiscoveryBatch } from "./service";

export interface CancelGameDiscoveryBatchResult {
  cancelled: boolean;
  alreadyTerminal: boolean;
  rootJobId: string;
  cancelledJobs: number;
  cancelledCreativeRuns: number;
  cancelledResearchRuns: number;
  cancelledStages: number;
  cancelledProviderTasks: number;
  reason: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function cancelGameDiscoveryBatch(input: {
  userId: string;
  runId: string;
  reason?: string | null;
}): Promise<CancelGameDiscoveryBatchResult | null> {
  const root = await getGameDiscoveryBatch({ userId: input.userId, runId: input.runId });
  if (!root || !root.factory_job_id) return null;

  const service = createSupabaseServiceClient();
  const { data, error } = await service.rpc("orchestrator_request_cancel", {
    p_root_job_id: root.factory_job_id,
    p_user_id: input.userId,
    p_reason: input.reason?.trim() || "user_stop",
  });
  if (error) throw new Error(`Failed to cancel Game Discovery batch: ${error.message}`);

  const row = object(data);
  if (row.cancelled !== true || typeof row.root_job_id !== "string") {
    throw new Error("Invalid orchestrator_request_cancel response");
  }

  return {
    cancelled: true,
    alreadyTerminal: row.already_terminal === true,
    rootJobId: row.root_job_id,
    cancelledJobs: count(row.cancelled_jobs),
    cancelledCreativeRuns: count(row.cancelled_creative_runs),
    cancelledResearchRuns: count(row.cancelled_research_runs),
    cancelledStages: count(row.cancelled_stages),
    cancelledProviderTasks: count(row.cancelled_provider_tasks),
    reason: typeof row.reason === "string" ? row.reason : "user_stop",
  };
}
