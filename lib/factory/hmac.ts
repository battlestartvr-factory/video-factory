import { createHmac } from "crypto";

export function signFactoryPayload(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export const FACTORY_TIMEOUT_MS = 12_000;

export function getFactoryWebhookConfig(env: {
  N8N_FACTORY_BASE_URL?: string;
  FACTORY_WEBHOOK_SECRET?: string;
  MOCK_WORKFLOWS?: boolean;
}) {
  const baseUrl = env.N8N_FACTORY_BASE_URL?.trim();
  const secret = env.FACTORY_WEBHOOK_SECRET?.trim();

  if (env.MOCK_WORKFLOWS || !baseUrl || !secret) {
    return null;
  }

  return { baseUrl: baseUrl.replace(/\/$/, ""), secret };
}
