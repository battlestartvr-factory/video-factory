import "server-only";

import { randomUUID } from "node:crypto";
import type { CreativeRun } from "@/lib/creative/types";
import { assertProjectAccess } from "@/lib/projects/access";
import { resolveResearchPolicyV1 } from "@/lib/research-intelligence/game-discovery-v2";
import type { ResearchPolicySpecV1 } from "@/lib/research-intelligence/schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  discoveryObjectiveSpecV1Schema,
  type DiscoveryObjectiveSpecV1,
} from "./schemas";

export interface CreateGameDiscoveryBatchV3Input {
  requestId?: string;
  userId: string;
  projectId?: string | null;
  objective: DiscoveryObjectiveSpecV1;
  hypothesis?: string | null;
  researchPolicy?: ResearchPolicySpecV1 | null;
}

export interface CreateGameDiscoveryBatchV3Result {
  creativeRun: CreativeRun;
  factoryJobId: string;
  duplicate: boolean;
  queueMsgId: number | null;
  traceId: string | null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function createGameDiscoveryBatchV3(
  input: CreateGameDiscoveryBatchV3Input,
): Promise<CreateGameDiscoveryBatchV3Result> {
  const objective = discoveryObjectiveSpecV1Schema.parse(input.objective);
  const researchPolicy = resolveResearchPolicyV1(input.researchPolicy);
  if (researchPolicy.mode === "disabled") {
    throw new Error("Game Discovery v3 requires bounded research");
  }
  if (input.projectId) await assertProjectAccess(input.userId, input.projectId);

  const requestId = input.requestId?.trim() || randomUUID();
  const service = createSupabaseServiceClient();
  const { data, error } = await service.rpc("orchestrator_create_game_discovery_batch_v3", {
    payload: {
      request_id: requestId,
      user_id: input.userId,
      project_id: input.projectId ?? null,
      discovery_objective: objective,
      hypothesis: input.hypothesis?.trim() || null,
      research_policy: researchPolicy,
    },
  });
  if (error) throw new Error(`Failed to create durable Game Discovery v3 batch: ${error.message}`);

  const row = object(data);
  const creativeRun = object(row.creative_run);
  if (typeof creativeRun.id !== "string" || typeof row.factory_job_id !== "string") {
    throw new Error("Invalid orchestrator_create_game_discovery_batch_v3 response");
  }

  return {
    creativeRun: creativeRun as unknown as CreativeRun,
    factoryJobId: row.factory_job_id,
    duplicate: row.duplicate === true,
    queueMsgId: typeof row.queue_msg_id === "number" ? row.queue_msg_id : null,
    traceId: typeof row.trace_id === "string" ? row.trace_id : null,
  };
}