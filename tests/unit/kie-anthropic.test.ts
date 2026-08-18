import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_ERROR_CODES } from "@/lib/agent/config";
import type { AgentRequest } from "@/lib/agent/types";
import {
  assertAnthropicMessagesNonEmpty,
  buildAnthropicMessages,
  buildAnthropicRequestParams,
  buildKieAnthropicBaseUrl,
  kieAnthropicProvider,
  resolveAnthropicThinkingMode,
  toAnthropicTool,
} from "@/lib/models/kie/adapters/kie-anthropic";
import { KieProviderError } from "@/lib/models/kie/errors";
import { getKieModelById } from "@/lib/models/kie/registry";
import { resolveReasoning } from "@/lib/models/kie/reasoning";

const KIE_ROOT = "https://api.kie.ai";
const sonnet = getKieModelById("claude-sonnet-5")!;
const haiku = getKieModelById("claude-haiku-4-5")!;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("KIE Claude registry contract", () => {
  it("uses exact Sonnet 5 and Haiku 4.5 provider model ids", () => {
    expect(sonnet.providerModel).toBe("claude-sonnet-5");
    expect(sonnet.endpoint).toBe("/claude/v1/messages");
    expect(sonnet.adapter).toBe("claude_messages");

    expect(haiku.providerModel).toBe("claude-haiku-4-5");
    expect(haiku.endpoint).toBe("/claude/v1/messages");
    expect(haiku.adapter).toBe("claude_messages");
  });

  it("builds the documented KIE Claude base URL", () => {
    expect(buildKieAnthropicBaseUrl(KIE_ROOT)).toBe(`${KIE_ROOT}/claude`);
  });
});

describe("KIE Claude request contract", () => {
  it("keeps system separate and sends an unmodified user turn to Sonnet 5", () => {
    const userText = "ты умеешь монтировать видео?";
    const input: AgentRequest = {
      model: "claude-sonnet-5",
      system: "Universal Agent base instructions.",
      messages: [{ role: "user", content: userText }],
      tools: [],
    };

    const { params, messages, currentUserChars } = buildAnthropicRequestParams(input, {
      baseUrl: KIE_ROOT,
      apiKey: "test",
      model: sonnet,
    });

    expect(messages).toEqual([{ role: "user", content: userText }]);
    expect(params.model).toBe("claude-sonnet-5");
    expect(params.system).toBe(input.system);
    expect(params.messages).toEqual(messages);
    expect(params.max_tokens).toBe(8192);
    expect(params.stream).toBe(false);
    expect(params.tools).toBeUndefined();
    expect(params.thinkingFlag).toBeUndefined();
    expect(currentUserChars).toBe(userText.length);
  });

  it("uses the same native Messages contract for Haiku 4.5", () => {
    const { params } = buildAnthropicRequestParams(
      {
        model: "claude-haiku-4-5",
        system: "Be concise.",
        messages: [{ role: "user", content: "Hello" }],
        tools: [],
      },
      { baseUrl: KIE_ROOT, apiKey: "test", model: haiku },
    );

    expect(params.model).toBe("claude-haiku-4-5");
    expect(params.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("preserves history, vision URL blocks and tool-result blocks", () => {
    const input: AgentRequest = {
      model: "claude-sonnet-5",
      system: "Instructions",
      messages: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            { type: "image_url", image_url: { url: "https://example.com/image.png" } },
          ],
        },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "toolu_1", name: "search_knowledge", arguments: { query: "x" } }],
        },
        { role: "tool", toolCallId: "toolu_1", content: "tool result" },
      ],
      tools: [],
    };

    const messages = buildAnthropicMessages(input);
    expect(messages[0]).toEqual({ role: "user", content: "First question" });
    expect(messages[1]).toEqual({ role: "assistant", content: "First answer" });
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
      ],
    });
    expect(messages[3]).toEqual({
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_1", name: "search_knowledge", input: { query: "x" } },
      ],
    });
    expect(messages[4]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "tool result" }],
    });
  });

  it("rejects empty user messages before any provider call", () => {
    expect(() => assertAnthropicMessagesNonEmpty([])).toThrowError(
      expect.objectContaining({ code: AGENT_ERROR_CODES.CLAUDE_EMPTY_MESSAGES }),
    );

    expect(() =>
      buildAnthropicRequestParams(
        { model: "claude-sonnet-5", system: "Instructions", messages: [], tools: [] },
        { baseUrl: KIE_ROOT, apiKey: "test", model: sonnet },
      ),
    ).toThrow(KieProviderError);
  });

  it("maps KIE thinking mode without adding a fake Anthropic thinking schema", () => {
    const standard = resolveAnthropicThinkingMode({
      baseUrl: KIE_ROOT,
      apiKey: "test",
      model: sonnet,
      reasoningLevel: "standard",
    });
    const thinking = resolveAnthropicThinkingMode({
      baseUrl: KIE_ROOT,
      apiKey: "test",
      model: sonnet,
      reasoningLevel: "thinking",
    });

    expect(standard).toEqual({ thinkingMode: "standard" });
    expect(thinking).toEqual({ thinkingMode: "thinking", thinkingFlag: true });
    expect(resolveReasoning(sonnet, "standard").providerParam).toEqual({});
    expect(resolveReasoning(sonnet, "thinking").providerParam).toEqual({ thinkingFlag: true });
  });

  it("converts app tools to native Claude input_schema", () => {
    expect(
      toAnthropicTool({
        name: "search_knowledge",
        description: "Search knowledge base",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      }),
    ).toEqual({
      name: "search_knowledge",
      description: "Search knowledge base",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    });
  });

  it("rejects an OpenAI function wrapper instead of leaking it to Claude", () => {
    expect(() =>
      toAnthropicTool({
        name: "search_knowledge",
        description: "Search",
        parameters: { type: "object", properties: {} },
        type: "function",
      } as never),
    ).toThrowError(
      expect.objectContaining({ code: AGENT_ERROR_CODES.CLAUDE_TOOL_SCHEMA_UNSUPPORTED }),
    );
  });
});

describe("KIE Claude wire integration", () => {
  it("POSTs Sonnet 5 directly to KIE with Bearer auth and anthropic-version", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Hello from Sonnet 5" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await kieAnthropicProvider.run(
      { baseUrl: KIE_ROOT, apiKey: "kie-secret", model: sonnet },
      {
        model: "claude-sonnet-5",
        system: "Be helpful.",
        messages: [{ role: "user", content: "Say hello" }],
        tools: [],
      },
    );

    expect(result.content).toBe("Hello from Sonnet 5");
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(`${KIE_ROOT}/claude/v1/messages`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer kie-secret",
      "anthropic-version": "2023-06-01",
    });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.messages).toEqual([{ role: "user", content: "Say hello" }]);
  });

  it("parses native Claude tool_use blocks into the agent tool-call shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg_tool",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_haiku_1",
              name: "search_knowledge",
              input: { query: "lesson 3" },
            },
          ],
          usage: { input_tokens: 20, output_tokens: 7 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await kieAnthropicProvider.run(
      { baseUrl: KIE_ROOT, apiKey: "kie-secret", model: haiku },
      {
        model: "claude-haiku-4-5",
        system: "Use tools when needed.",
        messages: [{ role: "user", content: "Find lesson 3" }],
        tools: [
          {
            name: "search_knowledge",
            description: "Search knowledge base",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
      },
    );

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "toolu_haiku_1", name: "search_knowledge", arguments: { query: "lesson 3" } },
    ]);
  });
});
