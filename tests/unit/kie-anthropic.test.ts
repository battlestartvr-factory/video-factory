import { describe, expect, it, vi } from "vitest";
import { AGENT_ERROR_CODES } from "@/lib/agent/config";
import { runAgentToolLoop } from "@/lib/agent/loop";
import type { AgentProvider, AgentProviderResponse, AgentRequest, ToolContext } from "@/lib/agent/types";
import {
  assertAnthropicMessagesNonEmpty,
  buildAnthropicMessages,
  buildAnthropicRequestParams,
  buildKieAnthropicBaseUrl,
  resolveAnthropicThinkingMode,
  toAnthropicTool,
} from "@/lib/models/kie/adapters/kie-anthropic";
import { resolveToolsForTurn } from "@/lib/agent/tools";
import { KieProviderError } from "@/lib/models/kie/errors";
import { getKieModelById } from "@/lib/models/kie/registry";
import { resolveReasoning } from "@/lib/models/kie/reasoning";

const KIE_ROOT = "https://api.kie.ai";
const model = getKieModelById("claude-sonnet-4-5")!;

describe("KieAnthropicProvider request contract", () => {
  it("resolves claude-sonnet-4-5 to KIE Anthropic-compatible base URL", () => {
    expect(buildKieAnthropicBaseUrl(KIE_ROOT)).toBe(`${KIE_ROOT}/claude`);
  });

  it('production-equivalent plain chat: "ты умеешь монтировать видео?"', () => {
    const userText = "ты умеешь монтировать видео?";
    const input: AgentRequest = {
      model: "claude-sonnet-4-5",
      system: "Universal Agent base instructions with runtime policy and preset layers.",
      messages: [{ role: "user", content: userText }],
      tools: [],
    };

    const { params, messages, systemChars, currentUserChars, lastMessageChars } =
      buildAnthropicRequestParams(input, {
        baseUrl: KIE_ROOT,
        apiKey: "test",
        model,
      });

    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe(userText);
    expect(String(messages[0]?.content)).not.toContain("<agent_instructions>");
    expect(String(messages[0]?.content)).not.toContain("<user_request>");

    expect(params.system).toBe(input.system);
    expect(params.model).toBe("claude-sonnet-4-5");
    expect(params.max_tokens).toBe(4096);
    expect(params.stream).toBe(false);
    expect(params.thinkingFlag).toBeUndefined();
    expect(params.tools).toBeUndefined();

    expect(currentUserChars).toBe(userText.length);
    expect(lastMessageChars).toBe(userText.length);
    expect(systemChars).toBeGreaterThan(userText.length);
  });

  it('builds plain "Say hello" payload with system separate from user message', () => {
    const input: AgentRequest = {
      model: "claude-sonnet-4-5",
      system: "Base agent instructions.",
      messages: [{ role: "user", content: "Say hello" }],
      tools: [],
    };

    const { params, messages } = buildAnthropicRequestParams(input, {
      baseUrl: KIE_ROOT,
      apiKey: "test",
      model,
    });

    expect(params.system).toBe("Base agent instructions.");
    expect(messages).toEqual([{ role: "user", content: "Say hello" }]);
  });

  it("never modifies the current user message (Russian plain chat)", () => {
    const input: AgentRequest = {
      model: "claude-sonnet-4-5",
      system: "Universal Agent base instructions.",
      messages: [{ role: "user", content: "Привет" }],
      tools: [],
    };

    const messages = buildAnthropicMessages(input);

    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({ role: "user", content: "Привет" });
  });

  it("includes prior history plus unmodified current user turn", () => {
    const input: AgentRequest = {
      model: "claude-sonnet-4-5",
      system: "Instructions",
      messages: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Follow up" },
      ],
      tools: [],
    };

    const messages = buildAnthropicMessages(input);

    expect(messages).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Follow up" },
    ]);
  });

  it("keeps system instructions out of messages", () => {
    const input: AgentRequest = {
      model: "claude-sonnet-4-5",
      system: "Runtime policy and global instructions.",
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
    };

    const { params, messages } = buildAnthropicRequestParams(input, {
      baseUrl: KIE_ROOT,
      apiKey: "test",
      model,
    });

    expect(params.system).toContain("Runtime policy");
    expect(JSON.stringify(messages)).not.toContain("Runtime policy");
  });

  it("rejects empty messages locally without calling provider", () => {
    expect(() => assertAnthropicMessagesNonEmpty([])).toThrowError(
      expect.objectContaining({ code: AGENT_ERROR_CODES.CLAUDE_EMPTY_MESSAGES }),
    );

    expect(() =>
      buildAnthropicRequestParams(
        {
          model: "claude-sonnet-4-5",
          system: "Instructions",
          messages: [],
          tools: [],
        },
        { baseUrl: KIE_ROOT, apiKey: "test", model },
      ),
    ).toThrow(KieProviderError);
  });

  it("Standard thinking omits thinkingFlag", () => {
    const { params } = buildAnthropicRequestParams(
      {
        model: "claude-sonnet-4-5",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      },
      { baseUrl: KIE_ROOT, apiKey: "test", model, reasoningLevel: "standard" },
    );
    expect(params.thinkingFlag).toBeUndefined();
    expect(
      resolveAnthropicThinkingMode({
        baseUrl: KIE_ROOT,
        apiKey: "test",
        model,
        reasoningLevel: "standard",
      }).thinkingMode,
    ).toBe("standard");
  });

  it("Thinking mode sends thinkingFlag: true", () => {
    const { params } = buildAnthropicRequestParams(
      {
        model: "claude-sonnet-4-5",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      },
      { baseUrl: KIE_ROOT, apiKey: "test", model, reasoningLevel: "thinking" },
    );
    expect(params.thinkingFlag).toBe(true);
  });

  it("maps resolveReasoning Standard without thinkingFlag", () => {
    expect(resolveReasoning(model, "standard").providerParam).toEqual({});
  });

  it("maps resolveReasoning Thinking to thinkingFlag", () => {
    expect(resolveReasoning(model, "thinking").providerParam).toEqual({ thinkingFlag: true });
  });

  it("builds Anthropic tool schema via toAnthropicTool", () => {
    const tool = toAnthropicTool({
      name: "search_knowledge",
      description: "Search knowledge base",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    });

    expect(tool).toEqual({
      name: "search_knowledge",
      description: "Search knowledge base",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    });
  });

  it("rejects OpenAI function wrapper for Claude", () => {
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

  it("includes tools in request params when provided", () => {
    const { params } = buildAnthropicRequestParams(
      {
        model: "claude-sonnet-4-5",
        system: "test",
        messages: [{ role: "user", content: "Search" }],
        tools: [
          {
            name: "search_knowledge",
            description: "Search",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      { baseUrl: KIE_ROOT, apiKey: "test", model },
    );

    expect(Array.isArray(params.tools)).toBe(true);
    const firstTool = params.tools?.[0] as { name: string; input_schema: unknown } | undefined;
    expect(firstTool?.name).toBe("search_knowledge");
    expect(firstTool?.input_schema).toBeDefined();
  });
});

describe("KieAnthropicProvider SDK integration", () => {
  it("uses Anthropic SDK against KIE Claude proxy for plain hello", async () => {
    const createMock = vi.fn().mockResolvedValue({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello!" }],
      model: "claude-sonnet-4-5",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation: null,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        inference_geo: null,
        server_tool_use: null,
        service_tier: "standard",
        output_tokens_details: null,
      },
    });

    class MockAnthropic {
      messages = { create: createMock };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      constructor(_opts: unknown) {}
    }

    vi.doMock("@anthropic-ai/sdk", () => ({
      default: MockAnthropic,
      APIError: class APIError extends Error {
        status?: number;
        error?: unknown;
        constructor(status: number, message: string, error?: unknown) {
          super(message);
          this.status = status;
          this.error = error;
        }
      },
    }));

    vi.resetModules();
    const { kieAnthropicProvider: provider } = await import("@/lib/models/kie/adapters/kie-anthropic");

    const result = await provider.run(
      { baseUrl: KIE_ROOT, apiKey: "test-key", model },
      {
        model: "claude-sonnet-4-5",
        system: "Be helpful.",
        messages: [{ role: "user", content: "Say hello" }],
        tools: [],
      },
    );

    expect(result.content).toBe("Hello!");
    expect(createMock).toHaveBeenCalledOnce();

    const callArgs = createMock.mock.calls[0]?.[0] as {
      model: string;
      system: string;
      messages: Array<{ role: string; content: string }>;
      tools?: unknown;
      thinkingFlag?: unknown;
    };

    expect(callArgs.model).toBe("claude-sonnet-4-5");
    expect(callArgs.system).toBe("Be helpful.");
    expect(callArgs.messages).toEqual([{ role: "user", content: "Say hello" }]);
    expect(callArgs.tools).toBeUndefined();
    expect(callArgs.thinkingFlag).toBeUndefined();

    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });
});

describe("Claude context-aware tools regression", () => {
  it('"Привет" resolves to 0 tools and plain Claude request has no tools key', () => {
    const resolved = resolveToolsForTurn({ userMessage: "Привет" });
    expect(resolved.tools).toHaveLength(0);

    const input: AgentRequest = {
      model: "claude-sonnet-4-5",
      system: "Universal Agent base instructions.",
      messages: [{ role: "user", content: "Привет" }],
      tools: resolved.tools,
    };

    const { params, messages } = buildAnthropicRequestParams(input, {
      baseUrl: KIE_ROOT,
      apiKey: "test",
      model,
    });

    expect(messages.length).toBe(1);
    expect(params.tools).toBeUndefined();
  });

  it("knowledge request passes only knowledge tools to Claude", () => {
    const resolved = resolveToolsForTurn({
      userMessage: 'Расскажи про урок 3 «Волшебная копилка» из базы знаний',
    });

    expect(resolved.tools.length).toBeGreaterThan(0);
    expect(resolved.tools.length).toBeLessThanOrEqual(4);

    const { params } = buildAnthropicRequestParams(
      {
        model: "claude-sonnet-4-5",
        system: "test",
        messages: [{ role: "user", content: "Расскажи про урок 3" }],
        tools: resolved.tools,
      },
      { baseUrl: KIE_ROOT, apiKey: "test", model },
    );

    const tools = (params.tools ?? []) as Array<{ name: string; input_schema: unknown }>;
    expect(tools.every((tool) => tool.input_schema && typeof tool.input_schema === "object")).toBe(true);
    expect(tools.map((tool) => tool.name)).toEqual(resolved.toolNames);
  });
});

describe("Claude Sonnet tool roundtrip", () => {
  const ctx: ToolContext = {
    requestId: "req-claude",
    userId: "user-1",
    chatId: "chat-1",
    projectId: null,
    userMessageId: "msg-1",
    agentRunId: "run-1",
    userMessage: "Search knowledge base",
    attachments: [],
  };

  it("executes search_knowledge then returns final answer via provider-shaped loop", async () => {
    let call = 0;
    const provider: AgentProvider = {
      async run() {
        call += 1;
        if (call === 1) {
          return {
            content: null,
            toolCalls: [
              { id: "toolu_claude_1", name: "search_knowledge", arguments: { query: "test" } },
            ],
          } satisfies AgentProviderResponse;
        }
        return {
          content: "Claude found documents.",
          toolCalls: [],
        } satisfies AgentProviderResponse;
      },
    };

    const knowledgeTools = resolveToolsForTurn({
      userMessage: "Search knowledge base",
    }).tools;

    const result = await runAgentToolLoop({
      provider,
      model: "claude-sonnet-4-5",
      system: "test",
      messages: [{ role: "user", content: "Search knowledge base" }],
      tools: knowledgeTools,
      toolContext: ctx,
      maxIterations: 4,
    });

    expect(result.executions[0]?.call.name).toBe("search_knowledge");
    expect(result.content).toContain("Claude found");
    expect(result.stopReason).toBe("final");
  });

  it("Anthropic messages include tool_result blocks after tool execution", () => {
    const messages = buildAnthropicMessages({
      model: "claude-sonnet-4-5",
      system: "test",
      messages: [
        { role: "user", content: "Search" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "toolu_1", name: "search_knowledge", arguments: { query: "test" } }],
        },
        {
          role: "tool",
          toolCallId: "toolu_1",
          name: "search_knowledge",
          content: '{"hits":[]}',
        },
      ],
      tools: [],
    });

    expect(messages[1]?.content).toEqual([
      {
        type: "tool_use",
        id: "toolu_1",
        name: "search_knowledge",
        input: { query: "test" },
      },
    ]);
    expect(messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: '{"hits":[]}' },
    ]);
  });
});
