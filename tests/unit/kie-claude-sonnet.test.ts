import { describe, expect, it, vi } from "vitest";
import { AGENT_ERROR_CODES } from "@/lib/agent/config";
import { runAgentToolLoop } from "@/lib/agent/loop";
import type { AgentProvider, AgentProviderResponse, AgentRequest, ToolContext } from "@/lib/agent/types";
import {
  assertClaudeMessagesNonEmpty,
  buildClaudeSonnetMessages,
  buildClaudeSonnetRequestBody,
  buildClaudeSonnetTools,
  kieClaudeSonnetAdapter,
  parseClaudeSonnetResponse,
  resolveClaudeThinkingFlag,
  toKieClaudeTool,
} from "@/lib/models/kie/adapters/claude-sonnet";
import { resolveToolsForTurn } from "@/lib/agent/tools";
import { joinKieUrl } from "@/lib/models/kie/adapters/base";
import { KieProviderError } from "@/lib/models/kie/errors";
import { getKieModelById } from "@/lib/models/kie/registry";
import { resolveReasoning } from "@/lib/models/kie/reasoning";

const KIE_ROOT = "https://api.kie.ai";
const model = getKieModelById("claude-sonnet-5")!;

describe("KieClaudeSonnetAdapter request contract", () => {
  it("resolves claude-sonnet-5 to canonical KIE URL", () => {
    expect(joinKieUrl(KIE_ROOT, model.endpoint)).toBe(`${KIE_ROOT}/claude/v1/messages`);
  });

  it('builds plain "Say hello" payload matching KIE playground', () => {
    const input: AgentRequest = {
      model: "claude-sonnet-5",
      system: "Base agent instructions.",
      messages: [{ role: "user", content: "Say hello" }],
      tools: [],
    };

    const { body, messages } = buildClaudeSonnetRequestBody(input, {
      baseUrl: KIE_ROOT,
      apiKey: "test",
      model,
    });

    expect(body.model).toBe("claude-sonnet-5");
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(4096);
    expect(body.system).toBeUndefined();
    expect(body.thinkingFlag).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");
    expect(typeof messages[0]?.content).toBe("string");
    expect(messages[0]?.content).toContain("<agent_instructions>");
    expect(messages[0]?.content).toContain("Base agent instructions.");
    expect(messages[0]?.content).toContain("<user_request>");
    expect(messages[0]?.content).toContain("Say hello");
  });

  it("never loses the current user message (production regression)", () => {
    const input: AgentRequest = {
      model: "claude-sonnet-5",
      system: "Universal Agent base instructions.",
      messages: [{ role: "user", content: "Привет" }],
      tools: [],
    };

    const messages = buildClaudeSonnetMessages(input);

    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.at(-1)?.role).toBe("user");
    const lastContent = messages.at(-1)?.content;
    expect(typeof lastContent).toBe("string");
    expect(lastContent).toContain("Привет");
  });

  it("includes prior history plus enveloped current user turn", () => {
    const input: AgentRequest = {
      model: "claude-sonnet-5",
      system: "Instructions",
      messages: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Follow up" },
      ],
      tools: [],
    };

    const messages = buildClaudeSonnetMessages(input);

    expect(messages).toHaveLength(3);
    expect(messages[0]?.content).toContain("First question");
    expect(messages[0]?.content).toContain("<agent_instructions>");
    expect(messages[1]).toEqual({ role: "assistant", content: "First answer" });
    expect(messages[2]).toEqual({ role: "user", content: "Follow up" });
  });

  it("rejects empty messages locally without calling provider", () => {
    expect(() =>
      assertClaudeMessagesNonEmpty([]),
    ).toThrowError(expect.objectContaining({ code: AGENT_ERROR_CODES.CLAUDE_EMPTY_MESSAGES }));

    expect(() =>
      buildClaudeSonnetRequestBody(
        {
          model: "claude-sonnet-5",
          system: "Instructions",
          messages: [],
          tools: [],
        },
        { baseUrl: KIE_ROOT, apiKey: "test", model },
      ),
    ).toThrow(KieProviderError);
  });

  it("Standard thinking omits thinkingFlag", () => {
    const { body } = buildClaudeSonnetRequestBody(
      {
        model: "claude-sonnet-5",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      },
      { baseUrl: KIE_ROOT, apiKey: "test", model, reasoningLevel: "standard" },
    );
    expect(body.thinkingFlag).toBeUndefined();
    expect(resolveClaudeThinkingFlag({ baseUrl: KIE_ROOT, apiKey: "test", model, reasoningLevel: "standard" }).thinkingMode).toBe("standard");
  });

  it("Thinking mode sends thinkingFlag: true", () => {
    const { body } = buildClaudeSonnetRequestBody(
      {
        model: "claude-sonnet-5",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      },
      { baseUrl: KIE_ROOT, apiKey: "test", model, reasoningLevel: "thinking" },
    );
    expect(body.thinkingFlag).toBe(true);
  });

  it("maps resolveReasoning Standard without thinkingFlag", () => {
    expect(resolveReasoning(model, "standard").providerParam).toEqual({});
  });

  it("maps resolveReasoning Thinking to thinkingFlag", () => {
    expect(resolveReasoning(model, "thinking").providerParam).toEqual({ thinkingFlag: true });
  });

  it("builds KIE tool schema with input_schema via toKieClaudeTool", () => {
    const tool = toKieClaudeTool({
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
      toKieClaudeTool({
        name: "search_knowledge",
        description: "Search",
        parameters: { type: "object", properties: {} },
        type: "function",
      } as never),
    ).toThrowError(
      expect.objectContaining({ code: AGENT_ERROR_CODES.CLAUDE_TOOL_SCHEMA_UNSUPPORTED }),
    );
  });

  it("builds KIE tool schema with input_schema", () => {
    const tools = buildClaudeSonnetTools([
      {
        name: "search_knowledge",
        description: "Search knowledge base",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    ]);

    expect(tools[0]).toEqual({
      name: "search_knowledge",
      description: "Search knowledge base",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: [] },
    });
  });

  it("includes tools in request body when provided", () => {
    const { body } = buildClaudeSonnetRequestBody(
      {
        model: "claude-sonnet-5",
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

    expect(Array.isArray(body.tools)).toBe(true);
    expect((body.tools as Array<{ name: string }>)[0]?.name).toBe("search_knowledge");
    expect(body.tools).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "function" })]),
    );
  });
});

describe("KieClaudeSonnetAdapter response parsing", () => {
  it("parses text content from stream:false JSON", () => {
    const parsed = parseClaudeSonnetResponse({
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    expect(parsed.content).toBe("Hello!");
    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.finishReason).toBe("stop");
    expect(parsed.usage.total_tokens).toBe(15);
  });

  it("parses tool_use blocks", () => {
    const parsed = parseClaudeSonnetResponse({
      content: [
        { type: "tool_use", id: "toolu_1", name: "search_knowledge", input: { query: "test" } },
      ],
      stop_reason: "tool_use",
    });

    expect(parsed.toolCalls).toEqual([
      { id: "toolu_1", name: "search_knowledge", arguments: { query: "test" } },
    ]);
    expect(parsed.finishReason).toBe("tool_calls");
  });
});

describe("KieClaudeSonnetAdapter HTTP", () => {
  it("sends native fetch to KIE Claude endpoint for plain hello", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "Hello!" }],
          stop_reason: "end_turn",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await kieClaudeSonnetAdapter.run(
      { baseUrl: KIE_ROOT, apiKey: "test-key", model },
      {
        model: "claude-sonnet-5",
        system: "Be helpful.",
        messages: [{ role: "user", content: "Say hello" }],
        tools: [],
      },
    );

    expect(result.content).toBe("Hello!");
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${KIE_ROOT}/claude/v1/messages`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");

    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      tools?: unknown;
      thinkingFlag?: unknown;
    };

    expect(body.model).toBe("claude-sonnet-5");
    expect(body.messages.length).toBeGreaterThanOrEqual(1);
    expect(body.messages.at(-1)?.role).toBe("user");
    expect(body.messages.at(-1)?.content).toContain("Say hello");
    expect(body.tools).toBeUndefined();

    fetchSpy.mockRestore();
  });
});

describe("Claude context-aware tools regression", () => {
  it('"Привет" resolves to 0 tools and plain Claude request has no tools key', () => {
    const resolved = resolveToolsForTurn({ userMessage: "Привет" });
    expect(resolved.tools).toHaveLength(0);

    const input: AgentRequest = {
      model: "claude-sonnet-5",
      system: "Universal Agent base instructions.",
      messages: [{ role: "user", content: "Привет" }],
      tools: resolved.tools,
    };

    const { body, messages } = buildClaudeSonnetRequestBody(input, {
      baseUrl: KIE_ROOT,
      apiKey: "test",
      model,
    });

    expect(messages.length).toBe(1);
    expect(body.tools).toBeUndefined();
  });

  it("knowledge request passes only knowledge tools to Claude", () => {
    const resolved = resolveToolsForTurn({
      userMessage: 'Расскажи про урок 3 «Волшебная копилка» из базы знаний',
    });

    expect(resolved.tools.length).toBeGreaterThan(0);
    expect(resolved.tools.length).toBeLessThanOrEqual(4);

    const { body } = buildClaudeSonnetRequestBody(
      {
        model: "claude-sonnet-5",
        system: "test",
        messages: [{ role: "user", content: "Расскажи про урок 3" }],
        tools: resolved.tools,
      },
      { baseUrl: KIE_ROOT, apiKey: "test", model },
    );

    const tools = body.tools as Array<{ name: string; input_schema: unknown }>;
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

  it("executes search_knowledge then returns final answer via adapter-shaped provider", async () => {
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
      model: "claude-sonnet-5",
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

  it("adapter request includes tool_result blocks after tool execution", () => {
    const messages = buildClaudeSonnetMessages({
      model: "claude-sonnet-5",
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
