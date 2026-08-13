import { timingSafeEqual } from "crypto";

export const FACTORY_TIMEOUT_MS = 12_000;

/** n8n webhook relative paths (appended to N8N_FACTORY_BASE_URL). */
export const FACTORY_JOBS_WEBHOOK_PATH = "/factory/jobs";
export const FACTORY_JOB_ACTION_WEBHOOK_PATH = "/factory/jobs/action";
export const FACTORY_INFRASTRUCTURE_CHECK_PATH = "/factory/infrastructure-check";

/**
 * Static shared secret sent as x-factory-signature (n8n Header Auth exact match).
 * Not derived from body or timestamp.
 */
export function getFactoryWebhookAuthHeader(secret: string): string {
  return secret.trim();
}

export function verifyFactoryWebhookAuthHeader(
  headerValue: string | null | undefined,
  secret: string,
): boolean {
  if (!headerValue || !secret) return false;
  const expected = secret.trim();
  const received = headerValue.trim();
  if (expected.length !== received.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  } catch {
    return false;
  }
}

export function getFactoryWebhookCredentials(env: {
  N8N_FACTORY_BASE_URL?: string;
  FACTORY_WEBHOOK_SECRET?: string;
}) {
  const baseUrl = env.N8N_FACTORY_BASE_URL?.trim();
  const secret = env.FACTORY_WEBHOOK_SECRET?.trim();

  if (!baseUrl || !secret) {
    return null;
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), secret };
}

export function getFactoryWebhookConfig(env: {
  N8N_FACTORY_BASE_URL?: string;
  FACTORY_WEBHOOK_SECRET?: string;
  MOCK_WORKFLOWS?: boolean;
}) {
  if (env.MOCK_WORKFLOWS) {
    return null;
  }

  return getFactoryWebhookCredentials(env);
}

/**
 * Join base URL and relative path without duplicating path segments or /webhook.
 */
export function buildFactoryWebhookUrl(baseUrl: string, relativePath: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;

  if (base.endsWith(path)) {
    return base;
  }

  const lowerBase = base.toLowerCase();
  const lowerPath = path.toLowerCase();
  if (lowerBase.endsWith("/webhook") && lowerPath.startsWith("/webhook")) {
    return `${base}${path.slice("/webhook".length)}`;
  }

  return `${base}${path}`;
}
