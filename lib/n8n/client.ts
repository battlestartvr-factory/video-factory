import { serverEnv } from "@/lib/env/env.server";
import { isMockWorkflowsEnabled } from "@/lib/env/mock-workflows";
import { buildWebhookHeaders } from "@/lib/n8n/hmac";
import { createLogger } from "@/lib/logging/logger";
import type { JobType, JobMode } from "@/lib/types/database";

export interface N8nJobCreatedPayload {
  event: "job.created";
  eventId: string;
  jobId: string;
  projectId: string;
  type: JobType;
  mode: JobMode;
  language: string;
  targetPlatform: string;
  brief: string | null;
  source: {
    provider: string;
    externalId: string;
    url: string;
  };
  callbackUrl: string;
  createdAt: string;
}

export async function dispatchJobToN8n(
  payload: N8nJobCreatedPayload,
): Promise<{ dispatched: boolean; mock: boolean }> {
  const logger = createLogger({ jobId: payload.jobId, event: "job.created" });

  if (isMockWorkflowsEnabled() || !serverEnv.N8N_WEBHOOK_URL || !serverEnv.N8N_WEBHOOK_SECRET) {
    logger.info("Using mock workflow dispatch");
    return { dispatched: true, mock: true };
  }

  const body = JSON.stringify(payload);
  const headers = buildWebhookHeaders(body, serverEnv.N8N_WEBHOOK_SECRET, payload.eventId);

  const response = await fetch(serverEnv.N8N_WEBHOOK_URL, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    logger.error("n8n dispatch failed", { status: response.status });
    throw new Error("N8N_DISPATCH_FAILED");
  }

  return { dispatched: true, mock: false };
}
