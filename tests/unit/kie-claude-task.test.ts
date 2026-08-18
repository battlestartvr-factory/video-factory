import { describe, expect, it, vi } from "vitest";
import { KieClaudeTaskAdapter, KieClaudeTaskError } from "@/lib/models/kie/claude-task";

describe("KIE durable discovery LLM adapter", () => {
  it("remaps legacy Sonnet work to Gemini Pro without Claude thinking flags", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const adapter = new KieClaudeTaskAdapter("https://api.kie.ai", "secret", fetchMock as typeof fetch);

    const result = await adapter.generate({
      model: "claude-sonnet-5",
      system: "system",
      prompt: "prompt",
      thinking: false,
    });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(url).toBe("https://api.kie.ai/gemini-3-pro/v1/chat/completions");
    expect(body.model).toBe("gemini-3-pro");
    expect(body.thinkingFlag).toBeUndefined();
    expect(result.text).toBe("ok");
    expect(result.usage.totalTokens).toBe(12);
  });

  it("keeps a bounded provider reason on HTTP failures and redacts auth material", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            type: "provider_error",
            message: "Gateway timeout while generating response; api_key=super-secret",
          },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      ),
    );
    const adapter = new KieClaudeTaskAdapter("https://api.kie.ai", "secret", fetchMock as typeof fetch);

    let caught: unknown;
    try {
      await adapter.generate({ model: "claude-sonnet-5", system: "system", prompt: "prompt" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(KieClaudeTaskError);
    const providerError = caught as KieClaudeTaskError;
    expect(providerError.status).toBe(500);
    expect(providerError.retryable).toBe(true);
    expect(providerError.message).toContain("Gateway timeout while generating response");
    expect(providerError.message).not.toContain("super-secret");
    expect(providerError.message).toContain("[redacted]");
  });
});
