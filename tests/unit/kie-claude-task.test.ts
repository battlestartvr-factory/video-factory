import { describe, expect, it, vi } from "vitest";
import { KieClaudeTaskAdapter, KieClaudeTaskError } from "@/lib/models/kie/claude-task";

describe("KIE Claude durable task adapter", () => {
  it("omits thinkingFlag for a standard structured request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 10, output_tokens: 2 },
          stop_reason: "end_turn",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const adapter = new KieClaudeTaskAdapter("https://api.kie.ai", "secret", fetchMock as typeof fetch);

    await adapter.generate({
      model: "claude-sonnet-5",
      system: "system",
      prompt: "prompt",
      thinking: false,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.thinkingFlag).toBeUndefined();
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

    await expect(
      adapter.generate({ model: "claude-sonnet-5", system: "system", prompt: "prompt" }),
    ).rejects.toEqual(
      expect.objectContaining<KieClaudeTaskError>({
        status: 500,
        retryable: true,
        message: expect.stringContaining("Gateway timeout while generating response"),
      }),
    );

    try {
      await adapter.generate({ model: "claude-sonnet-5", system: "system", prompt: "prompt" });
    } catch (error) {
      expect(String(error)).not.toContain("super-secret");
      expect(String(error)).toContain("[redacted]");
    }
  });
});
