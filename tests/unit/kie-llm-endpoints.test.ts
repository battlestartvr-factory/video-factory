import { describe, expect, it } from "vitest";
import {
  joinKieUrl,
  parseKieResponseBody,
  toResponsesInput,
} from "@/lib/models/kie/adapters/base";
import {
  classifyKieHttpStatus,
  normalizeKieError,
  parseKieErrorBody,
  userFacingProviderMessage,
} from "@/lib/models/kie/errors";
import { PROVIDER_ERROR_CODES } from "@/lib/models/kie/types";
import { getKieModelById } from "@/lib/models/kie/registry";
import { resolveReasoning } from "@/lib/models/kie/reasoning";
import { normalizeKieBaseUrl } from "@/lib/env/env.server";
import { runAgentToolLoop } from "@/lib/agent/loop";
import { getToolDefinitions } from "@/lib/agent/tools";
import type { AgentProvider, AgentProviderResponse, ToolContext } from "@/lib/agent/types";

const KIE_ROOT = "https://api.kie.ai";

describe("KIE LLM endpoint URLs", () => {
  const cases = [
    {
      modelId: "gemini-3-6-flash",
      expected: `${KIE_ROOT}/gemini-3-6-flash-openai/v1/chat/completions`,
    },
    {
      modelId: "gemini-3-pro",
      expected: `${KIE_ROOT}/gemini-3-pro/v1/chat/completions`,
    },
    {
      modelId: "gpt-5-6-sol",
      expected: `${KIE_ROOT}/codex/v1/responses`,
    },
    {
      modelId: "claude-sonnet-5",
      expected: `${KIE_ROOT}/claude/v1/messages`,
    },
  ] as const;

  it.each(cases)("resolves $modelId to the canonical KIE URL", ({ modelId, expected }) => {
    const model = getKieModelById(modelId);
    expect(model).toBeDefined();
    expect(joinKieUrl(KIE_ROOT, model!.endpoint)).toBe(expected);
  });
});

describe("KIE base URL normalization", () => {
  it("strips model-specific legacy AGENT_LLM_BASE_URL paths to provider root", () => {
    expect(
      normalizeKieBaseUrl("https://api.kie.ai/gemini-3-6-flash-openai/v1/chat/completions"),
    ).toBe("https://api.kie.ai");
    expect(normalizeKieBaseUrl("https://api.kie.ai/codex/v1/responses")).toBe("https://api.kie.ai");
    expect(normalizeKieBaseUrl("https://api.kie.ai/")).toBe("https://api.kie.ai");
  });

  it("preserves non-KIE legacy base URLs unchanged", () => {
    expect(normalizeKieBaseUrl("https://proxy.example.com/v1")).toBe("https://proxy.example.com/v1");
  });
});

describe("KIE LLM request contracts", () => {
  it("maps GPT 5.6 Sol reasoning to reasoning.effort", () => {
    const model = getKieModelById("gpt-5-6-sol")!;
    const resolved = resolveReasoning(model, "max");
    expect(resolved.providerParam).toEqual({ reasoning: { effort: "xhigh" } });
  });

  it("maps Gemini reasoning to reasoning_effort", () => {
    const model = getKieModelById("gemini-3-6-flash")!;
    const resolved = resolveReasoning(model, "high");
    expect(resolved.providerParam).toEqual({ reasoning_effort: "high" });
  });

  it("builds Responses API input with function_call and function_call_output", () => {
    const input = toResponsesInput("You are helpful.", [
      { role: "user", content: "Find docs" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call_1", name: "search_knowledge", arguments: { query: "test" } }],
      },
      {
        role: "tool",
        toolCallId: "call_1",
        name: "search_knowledge",
        content: '{"hits":[]}',
      },
    ]);

    expect(input[0]).toEqual({
      role: "system",
      content: [{ type: "input_text", text: "You are helpful." }],
    });
    expect(input[1]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "Find docs" }],
    });
    expect(input[2]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "search_knowledge",
      arguments: JSON.stringify({ query: "test" }),
    });
    expect(input[3]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: '{"hits":[]}',
    });
  });
});

describe("KIE response parsing", () => {
  it("assembles SSE payloads into a Responses object", async () => {
    const sseBody = [
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"Done"}]}]}}',
    ].join("\n");

    const response = new Response(sseBody, {
      headers: { "content-type": "text/event-stream" },
    });
    const { payload, parseStage } = await parseKieResponseBody(response);
    expect(parseStage).toBe("sse_assembled");
    expect(payload).toEqual({
      output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }],
    });
  });
});

describe("KIE provider error diagnostics", () => {
  it("classifies HTTP status codes for server logs", () => {
    expect(classifyKieHttpStatus(401)).toBe("authentication");
    expect(classifyKieHttpStatus(404)).toBe("wrong_endpoint");
    expect(classifyKieHttpStatus(400)).toBe("invalid_request");
    expect(classifyKieHttpStatus(429)).toBe("rate_limit");
    expect(classifyKieHttpStatus(500)).toBe("provider_failure");
  });

  it("parses provider error metadata without exposing secrets", () => {
    const parsed = parseKieErrorBody(
      JSON.stringify({
        error: { type: "authentication_error", message: "Invalid API key" },
        id: "req_abc123",
      }),
    );
    expect(parsed).toEqual({
      providerErrorType: "authentication_error",
      requestId: "req_abc123",
    });
  });

  it("keeps user-facing errors normalized", () => {
    expect(normalizeKieError(401, '{"error":{"type":"authentication_error"}}').code).toBe(
      PROVIDER_ERROR_CODES.PROVIDER_ERROR,
    );
    expect(normalizeKieError(404, "").code).toBe(PROVIDER_ERROR_CODES.MODEL_UNAVAILABLE);
    expect(normalizeKieError(400, '{"error":{"type":"invalid_request_error"}}').code).toBe(
      PROVIDER_ERROR_CODES.PROVIDER_ERROR,
    );
    expect(
      normalizeKieError(400, '{"error":{"type":"invalid_request_error"}}', "", "claude_sonnet")
        .code,
    ).toBe(PROVIDER_ERROR_CODES.CLAUDE_REQUEST_INVALID);
    expect(userFacingProviderMessage(PROVIDER_ERROR_CODES.CLAUDE_REQUEST_INVALID)).toContain(
      "Claude",
    );
  });
});

describe("GPT Responses tool roundtrip", () => {
  const ctx: ToolContext = {
    requestId: "req-gpt",
    userId: "user-1",
    chatId: "chat-1",
    projectId: null,
    userMessageId: "msg-1",
    agentRunId: "run-1",
    userMessage: "Search knowledge base",
    attachments: [],
  };

  it("executes search_knowledge then returns final answer", async () => {
    let call = 0;
    const provider: AgentProvider = {
      async run() {
        call += 1;
        if (call === 1) {
          return {
            content: null,
            toolCalls: [
              { id: "call_gpt_1", name: "search_knowledge", arguments: { query: "test" } },
            ],
          } satisfies AgentProviderResponse;
        }
        return {
          content: "Found relevant documents.",
          toolCalls: [],
        } satisfies AgentProviderResponse;
      },
    };

    const result = await runAgentToolLoop({
      provider,
      model: "gpt-5-6-sol",
      system: "test",
      messages: [{ role: "user", content: "Search knowledge base" }],
      tools: getToolDefinitions(),
      toolContext: ctx,
      maxIterations: 4,
    });

    expect(result.executions[0]?.call.name).toBe("search_knowledge");
    expect(result.content).toContain("Found relevant");
    expect(result.stopReason).toBe("final");
  });
});
