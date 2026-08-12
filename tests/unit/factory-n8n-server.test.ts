import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  FACTORY_JOB_ACTION_WEBHOOK_PATH,
  FACTORY_JOBS_WEBHOOK_PATH,
  FACTORY_TIMEOUT_MS,
  buildFactoryWebhookUrl,
  getFactoryWebhookAuthHeader,
  getFactoryWebhookConfig,
  verifyFactoryWebhookAuthHeader,
} from "@/lib/factory/webhook-auth";

describe("factory webhook auth header (static shared secret)", () => {
  it("returns exact FACTORY_WEBHOOK_SECRET value", () => {
    expect(getFactoryWebhookAuthHeader("my-static-secret")).toBe("my-static-secret");
  });

  it("accepts matching x-factory-signature", () => {
    expect(verifyFactoryWebhookAuthHeader("my-static-secret", "my-static-secret")).toBe(true);
  });

  it("rejects wrong x-factory-signature", () => {
    expect(verifyFactoryWebhookAuthHeader("wrong-secret", "my-static-secret")).toBe(false);
  });

  it("rejects null header", () => {
    expect(verifyFactoryWebhookAuthHeader(null, "my-static-secret")).toBe(false);
  });

  it("does not derive signature from request body", () => {
    const secret = "shared-secret";
    const header = getFactoryWebhookAuthHeader(secret);
    expect(header).toBe(secret);
    expect(header).not.toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("factory webhook URL builder", () => {
  it("appends relative path to base URL", () => {
    expect(buildFactoryWebhookUrl("https://n8n.example.test", FACTORY_JOBS_WEBHOOK_PATH)).toBe(
      "https://n8n.example.test/factory/jobs",
    );
  });

  it("does not duplicate path when base already includes it", () => {
    expect(
      buildFactoryWebhookUrl(
        "https://n8n.example.test/webhook/abc/factory/jobs",
        FACTORY_JOBS_WEBHOOK_PATH,
      ),
    ).toBe("https://n8n.example.test/webhook/abc/factory/jobs");
  });

  it("avoids double /webhook segment", () => {
    expect(
      buildFactoryWebhookUrl("https://n8n.example.test/webhook", "/webhook/factory/jobs"),
    ).toBe("https://n8n.example.test/webhook/factory/jobs");
  });

  it("uses /factory/jobs/action for job actions", () => {
    expect(FACTORY_JOB_ACTION_WEBHOOK_PATH).toBe("/factory/jobs/action");
  });
});

describe("factory webhook config", () => {
  it("returns null when mock workflows enabled", () => {
    expect(
      getFactoryWebhookConfig({
        MOCK_WORKFLOWS: true,
        N8N_FACTORY_BASE_URL: "https://n8n.example.test/webhook",
        FACTORY_WEBHOOK_SECRET: "secret",
      }),
    ).toBeNull();
  });

  it("strips trailing slash from base URL", () => {
    const config = getFactoryWebhookConfig({
      MOCK_WORKFLOWS: false,
      N8N_FACTORY_BASE_URL: "https://n8n.example.test/webhook/",
      FACTORY_WEBHOOK_SECRET: "secret",
    });
    expect(config?.baseUrl).toBe("https://n8n.example.test/webhook");
  });
});

describe("factory n8n client fetch behavior", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends static x-factory-signature header", async () => {
    const secret = "factory-static-secret";
    const body = JSON.stringify({ event: "factory.job.created" });

    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }) as Response);

    await fetch(buildFactoryWebhookUrl("https://n8n.example.test/webhook", FACTORY_JOBS_WEBHOOK_PATH), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-factory-signature": getFactoryWebhookAuthHeader(secret),
      },
      body,
      signal: AbortSignal.timeout(FACTORY_TIMEOUT_MS),
    });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-factory-signature"]).toBe(secret);
    expect(init.body).not.toContain(secret);
  });
});
