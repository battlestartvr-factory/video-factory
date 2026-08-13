import "server-only";

import { serverEnv } from "@/lib/env/env.server";
import {
  FACTORY_INFRASTRUCTURE_CHECK_PATH,
  FACTORY_TIMEOUT_MS,
  buildFactoryWebhookUrl,
  getFactoryWebhookAuthHeader,
  getFactoryWebhookCredentials,
} from "@/lib/factory/webhook-auth";

export interface Wf00CheckResult {
  ok: boolean;
  n8n?: { reachable?: boolean };
  drive?: { reachable?: boolean };
  message?: string;
}

function parseWf00Response(body: unknown): Wf00CheckResult {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "Invalid WF00 response" };
  }

  const record = body as Record<string, unknown>;
  const n8nRecord =
    record.n8n && typeof record.n8n === "object"
      ? (record.n8n as Record<string, unknown>)
      : null;
  const driveRecord =
    record.drive && typeof record.drive === "object"
      ? (record.drive as Record<string, unknown>)
      : null;

  return {
    ok: record.ok === true,
    n8n: n8nRecord
      ? { reachable: n8nRecord.reachable === true }
      : undefined,
    drive: driveRecord
      ? { reachable: driveRecord.reachable === true }
      : undefined,
    message:
      typeof record.message === "string" && record.message.trim()
        ? record.message.trim()
        : undefined,
  };
}

/**
 * Calls production WF00 Infrastructure Check via factory webhook auth.
 * Returns null when factory n8n credentials are not configured.
 */
export async function runWf00InfrastructureCheck(): Promise<Wf00CheckResult | null> {
  const credentials = getFactoryWebhookCredentials(serverEnv);
  if (!credentials) {
    return null;
  }

  const url = buildFactoryWebhookUrl(
    credentials.baseUrl,
    FACTORY_INFRASTRUCTURE_CHECK_PATH,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FACTORY_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-factory-signature": getFactoryWebhookAuthHeader(credentials.secret),
      },
      body: JSON.stringify({ event: "infrastructure.check" }),
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        message: response.ok
          ? "WF00 returned non-JSON response"
          : `WF00 HTTP ${response.status}`,
      };
    }

    const result = parseWf00Response(parsed);
    if (!response.ok && result.ok) {
      return { ok: false, message: `WF00 HTTP ${response.status}` };
    }

    return result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, message: "WF00 check timed out" };
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : "WF00 check failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}
