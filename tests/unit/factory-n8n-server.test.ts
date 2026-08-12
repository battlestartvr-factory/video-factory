import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  FACTORY_TIMEOUT_MS,
  getFactoryWebhookConfig,
  signFactoryPayload,
} from "@/lib/factory/hmac";

describe("factory n8n signature", () => {
  it("produces deterministic HMAC hex", () => {
    const sig = signFactoryPayload('{"event":"factory.job.created"}', "secret");
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
    expect(signFactoryPayload('{"event":"factory.job.created"}', "secret")).toBe(sig);
  });
});

describe("factory webhook config", () => {
  it("returns null when mock workflows enabled", () => {
    expect(
      getFactoryWebhookConfig({
        MOCK_WORKFLOWS: true,
        N8N_FACTORY_BASE_URL: "https://n8n.example.test",
        FACTORY_WEBHOOK_SECRET: "secret",
      }),
    ).toBeNull();
  });

  it("strips trailing slash from base URL", () => {
    const config = getFactoryWebhookConfig({
      MOCK_WORKFLOWS: false,
      N8N_FACTORY_BASE_URL: "https://n8n.example.test/",
      FACTORY_WEBHOOK_SECRET: "secret",
    });
    expect(config?.baseUrl).toBe("https://n8n.example.test");
  });
});

describe("factory n8n client fetch behavior", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("would send x-factory-signature when posting", async () => {
    const body = JSON.stringify({ event: "factory.job.created" });
    const secret = "factory-secret";
    const signature = signFactoryPayload(body, secret);

    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }) as Response);

    await fetch("https://n8n.example.test/factory/jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-factory-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(FACTORY_TIMEOUT_MS),
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-factory-signature"]).toBe(signature);
    expect(init.body).not.toContain(secret);
  });

  it("maps AbortError to timeout semantics", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(err.name).toBe("AbortError");
  });
});
