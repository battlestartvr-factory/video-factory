import { describe, expect, it, vi } from "vitest";
import { KieMarketTaskError } from "@/lib/models/kie/market-task";
import { KieVeoTaskAdapter } from "@/lib/models/kie/veo-task";

describe("KieVeoTaskAdapter", () => {
  it("submits Veo generation with callback correlation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ code: 200, data: { taskId: "veo-task-1" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const adapter = new KieVeoTaskAdapter(
      "https://api.kie.ai",
      "secret",
      fetchMock as unknown as typeof fetch,
    );

    const result = await adapter.submit({
      model: "veo3_fast",
      callbackUrl: "https://factory.example.test/api/providers/kie/callback/pt/token",
      providerInput: {
        prompt: "factory",
        aspect_ratio: "16:9",
        generationType: "TEXT_2_VIDEO",
      },
    });

    expect(result.taskId).toBe("veo-task-1");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.kie.ai/api/v1/veo/generate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      prompt: "factory",
      aspect_ratio: "16:9",
      generationType: "TEXT_2_VIDEO",
      model: "veo3_fast",
      callBackUrl: "https://factory.example.test/api/providers/kie/callback/pt/token",
    });
  });

  it("maps canonical Veo success into the shared provider task shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 200,
          data: {
            taskId: "veo-task-1",
            successFlag: 1,
            response: { resultUrls: ["https://example.test/veo.mp4"] },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const adapter = new KieVeoTaskAdapter(
      "https://api.kie.ai",
      "secret",
      fetchMock as unknown as typeof fetch,
    );

    const result = await adapter.getTask({ taskId: "veo-task-1" });

    expect(result.state).toBe("success");
    expect(result.resultUrls).toEqual(["https://example.test/veo.mp4"]);
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(String(url)).toContain("/api/v1/veo/record-info");
    expect(String(url)).toContain("taskId=veo-task-1");
  });

  it("treats submit transport failures as ambiguous and never safe to blind retry", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("socket reset"));
    const adapter = new KieVeoTaskAdapter(
      "https://api.kie.ai",
      "secret",
      fetchMock as unknown as typeof fetch,
    );

    await expect(
      adapter.submit({
        model: "veo3_fast",
        callbackUrl: "https://factory.example.test/callback",
        providerInput: { prompt: "factory" },
      }),
    ).rejects.toMatchObject({
      name: KieMarketTaskError.name,
      retryable: true,
      ambiguousSubmit: true,
    });
  });
});
