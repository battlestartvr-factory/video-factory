import { describe, expect, it } from "vitest";
import { runAgentToolLoop } from "@/lib/agent/loop";
import { getToolDefinitions } from "@/lib/agent/tools";
import type { AgentProvider, AgentProviderResponse, ToolContext } from "@/lib/agent/types";

const ctx: ToolContext = {
  requestId: "req-1",
  userId: "user-1",
  chatId: "chat-1",
  projectId: null,
  userMessageId: "msg-1",
  agentRunId: "run-1",
  userMessage: "Напиши пост про VR",
  attachments: [],
};

function providerSequence(responses: AgentProviderResponse[]): AgentProvider {
  let index = 0;
  return {
    async run() {
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return next;
    },
  };
}

describe("agent tool loop", () => {
  it("returns final content when the model does not call tools", async () => {
    const result = await runAgentToolLoop({
      provider: providerSequence([
        { content: "Вот пост про кооперативный VR.", toolCalls: [] },
      ]),
      model: "test-model",
      system: "test",
      messages: [{ role: "user", content: "Напиши пост" }],
      tools: getToolDefinitions(),
      toolContext: ctx,
    });
    expect(result.content).toContain("пост");
    expect(result.executions).toHaveLength(0);
    expect(result.stopReason).toBe("final");
  });

  it("executes multiple tools in one turn then answers", async () => {
    const result = await runAgentToolLoop({
      provider: providerSequence([
        {
          content: null,
          toolCalls: [
            { id: "1", name: "web_search", arguments: { query: "VR co-op trends" } },
            { id: "2", name: "answer_user", arguments: { content: "Сравнил внутреннее и внешнее." } },
          ],
        },
      ]),
      model: "test-model",
      system: "test",
      messages: [{ role: "user", content: "Сравни research с рынком" }],
      tools: getToolDefinitions(),
      toolContext: ctx,
      maxIterations: 4,
    });
    expect(result.executions.map((item) => item.call.name)).toEqual([
      "web_search",
      "answer_user",
    ]);
    expect(result.executions[0]?.normalized.ok).toBe(false);
    expect(result.executions[0]?.normalized.code).toBe("WEB_SEARCH_NOT_CONFIGURED");
    expect(result.content).toContain("Сравнил");
  });

  it("treats answer_user as a terminating tool", async () => {
    const result = await runAgentToolLoop({
      provider: providerSequence([
        {
          content: null,
          toolCalls: [{ id: "1", name: "answer_user", arguments: { content: "Итог готов." } }],
        },
      ]),
      model: "test-model",
      system: "test",
      messages: [{ role: "user", content: "Привет" }],
      tools: getToolDefinitions(),
      toolContext: ctx,
    });
    expect(result.content).toBe("Итог готов.");
    expect(result.stopReason).toBe("final");
  });

  it("stops at the tool iteration limit", async () => {
    const result = await runAgentToolLoop({
      provider: providerSequence([
        {
          content: null,
          toolCalls: [{ id: "loop", name: "unknown_tool", arguments: {} }],
        },
      ]),
      model: "test-model",
      system: "test",
      messages: [{ role: "user", content: "loop" }],
      tools: getToolDefinitions(),
      toolContext: ctx,
      maxIterations: 3,
    });
    expect(result.stopReason).toBe("tool_limit");
    expect(result.executions.length).toBe(3);
  });
});
