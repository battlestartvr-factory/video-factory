import "server-only";

import { serverEnv } from "@/lib/env/env.server";
import { createLogger } from "@/lib/logging/logger";
import {
  FACTORY_JOB_ACTION_WEBHOOK_PATH,
  FACTORY_JOBS_WEBHOOK_PATH,
  FACTORY_TIMEOUT_MS,
  buildFactoryWebhookUrl,
  getFactoryWebhookAuthHeader,
  getFactoryWebhookConfig,
} from "@/lib/factory/webhook-auth";
import type {
  N8nFactoryJobActionPayload,
  N8nFactoryJobCreatedPayload,
} from "@/lib/factory/contracts";

function getFactoryConfig() {
  return getFactoryWebhookConfig(serverEnv);
}

async function postToFactoryWebhook(
  relativePath: string,
  payload: N8nFactoryJobCreatedPayload | N8nFactoryJobActionPayload,
): Promise<{ status: number; mock: boolean }> {
  const config = getFactoryConfig();
  const logger = createLogger({
    event: payload.event,
    requestId: payload.requestId,
    jobId: payload.jobId,
  });

  if (!config) {
    logger.info("Factory n8n dispatch skipped (mock or not configured)");
    return { status: 202, mock: true };
  }

  const body = JSON.stringify(payload);
  const url = buildFactoryWebhookUrl(config.baseUrl, relativePath);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FACTORY_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-factory-signature": getFactoryWebhookAuthHeader(config.secret),
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.error("Factory n8n dispatch failed", { status: response.status });
      throw new Error("FACTORY_N8N_DISPATCH_FAILED");
    }

    return { status: response.status, mock: false };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.error("Factory n8n dispatch timed out");
      throw new Error("FACTORY_N8N_TIMEOUT");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function createFactoryJob(
  payload: N8nFactoryJobCreatedPayload,
): Promise<{ status: number; mock: boolean }> {
  return postToFactoryWebhook(FACTORY_JOBS_WEBHOOK_PATH, payload);
}

export async function sendFactoryJobAction(
  payload: N8nFactoryJobActionPayload,
): Promise<{ status: number; mock: boolean }> {
  return postToFactoryWebhook(FACTORY_JOB_ACTION_WEBHOOK_PATH, payload);
}

export function isFactoryN8nConfigured(): boolean {
  return Boolean(getFactoryConfig());
}
