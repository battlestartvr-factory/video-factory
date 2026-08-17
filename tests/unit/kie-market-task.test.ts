import { describe, expect, it, vi } from "vitest";
import { KieMarketTaskAdapter, KieMarketTaskError } from "@/lib/models/kie/market-task";

describe("KieMarketTaskAdapter", () => {
  it("submits Market tasks with callBackUrl and parses taskId", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "gpt-image-2-text-to-image",
        callBackUrl: "https://factory.example/api/providers/kie/callback/task/token",
        input: { prompt: "co-op gameplay" },
      });
      return new Response(JSON.stringify({ code: 200, msg: "success", data: { taskId: "task_123" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const adapter = new KieMarketTaskAdapter("https://api.kie.ai", "secret", fetchMock as typeof fetch);
    const result = await adapter.submit({
      model: "gpt-image-2-text-to-image",
      callbackUrl: "https://factory.example/api/providers/kie/callback/task/token",
      providerInput: { prompt: "co-op gameplay" },
    });
    expect(result.taskId).toBe("task_123");
  });

  it("marks createTask transport failures as ambiguous so callers never blind-retry the paid POST", async () => {
    const adapter = new KieMarketTaskAdapter(
      "https://api.kie.ai",
      "secret",
      vi.fn(async () => {
        throw new TypeError("socket closed");
      }) as unknown as typeof fetch,
    );

    await expect(
      adapter.submit({ model: "model", callbackUrl: "https://factory.example/callback", providerInput: {} }),
    ).rejects.toMatchObject({ ambiguousSubmit: true, retryable: true });
  });

  it("queries recordInfo and normalizes result URLs and accounting", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain("/api/v1/jobs/recordInfo?taskId=task_123");
      return new Response(
        JSON.stringify({
          code: 200,
          msg: "success",
          data: {
            taskId: "task_123",
            model: "gpt-image-2-text-to-image",
            state: "success",
            resultJson: JSON.stringify({ resultUrls: ["https://cdn.example/output.png"] }),
            creditsConsumed: 12,
            progress: 100,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const adapter = new KieMarketTaskAdapter("https://api.kie.ai", "secret", fetchMock as typeof fetch);
    const detail = await adapter.getTask({ taskId: "task_123" });
    expect(detail).toMatchObject({
      taskId: "task_123",
      state: "success",
      resultUrls: ["https://cdn.example/output.png"],
      creditsConsumed: 12,
      progress: 100,
    });
  });

  it("rejects unknown recordInfo states", async () => {
    const adapter = new KieMarketTaskAdapter(
      "https://api.kie.ai",
      "secret",
      vi.fn(async () =>
        new Response(JSON.stringify({ code: 200, data: { taskId: "task_1", state: "mystery" } }), {
          status: 200,
        }),
      ) as unknown as typeof fetch,
    );
    await expect(adapter.getTask({ taskId: "task_1" })).rejects.toBeInstanceOf(KieMarketTaskError);
  });
});
