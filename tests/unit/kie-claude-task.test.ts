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

  it("runs GPT 5.6 Terra through the Responses API with explicit non-stream mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"concepts":[]}' }],
            },
          ],
          usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
          status: "completed",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const adapter = new KieClaudeTaskAdapter("https://api.kie.ai", "secret", fetchMock as typeof fetch);

    const result = await adapter.generate({
      model: "gpt-5-6-terra",
      system: "strong system",
      prompt: "strong prompt",
      maxTokens: 2048,
      thinking: true,
    });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      model?: string;
      stream?: boolean;
      input?: Array<Record<string, unknown>>;
      max_output_tokens?: number;
      reasoning?: { effort?: string };
    };
    expect(url).toBe("https://api.kie.ai/codex/v1/responses");
    expect(body.model).toBe("gpt-5-6-terra");
    expect(body.stream).toBe(false);
    expect(body.max_output_tokens).toBe(2048);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.input).toEqual([
      { role: "system", content: [{ type: "input_text", text: "strong system" }] },
      { role: "user", content: [{ type: "input_text", text: "strong prompt" }] },
    ]);
    expect(result.text).toBe('{"concepts":[]}');
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 4, totalTokens: 12 });
    expect(result.stopReason).toBe("completed");
  });

  it("accepts a KIE text/event-stream response.completed envelope for Terra", async () => {
    const completed = {
      type: "response.completed",
      response: {
        id: "resp_test",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: '{"schema":"strong_concept_batch","concepts":[]}' }],
          },
        ],
        usage: { input_tokens: 123, output_tokens: 45, total_tokens: 168 },
        credits_consumed: 0.42,
      },
    };
    const sse = [
      "event: response.created",
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_test", status: "in_progress" } })}`,
      "",
      "event: response.completed",
      `data: ${JSON.stringify(completed)}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const adapter = new KieClaudeTaskAdapter("https://api.kie.ai", "secret", fetchMock as typeof fetch);

    const result = await adapter.generate({
      model: "gpt-5-6-terra",
      system: "system",
      prompt: "prompt",
      thinking: false,
    });

    expect(result.text).toBe('{"schema":"strong_concept_batch","concepts":[]}');
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 45, totalTokens: 168 });
    expect(result.stopReason).toBe("completed");
    expect(result.responsePayload.credits_consumed).toBe(0.42);
  });

  it("can reconstruct output_text from Responses delta SSE as a fallback", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: '{"concepts":' })}`,
      "",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "[]}" })}`,
      "",
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const adapter = new KieClaudeTaskAdapter("https://api.kie.ai", "secret", fetchMock as typeof fetch);

    const result = await adapter.generate({
      model: "gpt-5-6-terra",
      system: "system",
      prompt: "prompt",
      thinking: false,
    });

    expect(result.text).toBe('{"concepts":[]}');
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    expect(result.stopReason).toBe("completed");
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
