import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTENT_LIMITS } from "@/lib/agent/config";
import { createWebFetchProvider } from "@/lib/web";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Safe Fetch oversized research pages", () => {
  it("keeps a bounded HTML prefix instead of rejecting the entire source", async () => {
    const prefix = "<html><head><title>Oversized Review Page</title></head><body>Players praise the co-op rescue mechanic and complain about repetitive waiting. ";
    const html = prefix + "x".repeat(CONTENT_LIMITS.maxWebFetchBytes + 4_096) + "</body></html>";
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(new TextEncoder().encode(html).byteLength),
      },
    })) as typeof fetch;

    const provider = createWebFetchProvider(async () => [{ address: "93.184.216.34", family: 4 }]);
    const document = await provider.fetchPage("https://example.com/oversized-review");

    expect(document.truncated).toBe(true);
    expect(document.byteLength).toBe(CONTENT_LIMITS.maxWebFetchBytes);
    expect(document.title).toBe("Oversized Review Page");
    expect(document.text).toContain("Players praise the co-op rescue mechanic");
  });
});
