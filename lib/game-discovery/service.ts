import "server-only";

import { randomUUID } from "node:crypto";
import { assertProjectAccess } from "@/lib/projects/access";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { CreativeRun } from "@/lib/creative/types";
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
