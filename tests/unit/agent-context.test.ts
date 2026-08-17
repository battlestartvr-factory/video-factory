import { describe, expect, it } from "vitest";
import { buildAgentContext, historyToAgentMessages, modelSupportsVision } from "@/lib/agent/context-builder";
import { DEFAULT_GLOBAL_AGENT_INSTRUCTIONS } from "@/lib/agent/default-agent-instructions";
import { CONTEXT_BUDGET } from "@/lib/agent/config";
import type { AgentConfig } from "@/lib/agent/agent-config-service";
import type { Chat, ChatMessage } from "@/lib/types/workspace";

const chat: Chat = {
  id: "c1",
  user_id: "u1",
  project_id: null,
  title: "Chat",
  summary: "x".repeat(5000),
  model_id: "gemini-3-flash",
  preset_id: null,
  metadata: {},
  archived_at: null,
  created_at: "",
  updated_at: "",
};

const agentConfig: AgentConfig = {
  id: "cfg-1",
  user_id: "u1",
  name: "default",
  system_prompt: DEFAULT_GLOBAL_AGENT_INSTRUCTIONS,
  version: 1,
  created_at: "",
  updated_at: "",
};

describe("context engine", () => {
  it("includes runtime policy and agent instructions", () => {
    const ctx = buildAgentContext({
      chat,
      project: null,
      preset: null,
      agentConfig,
      preferences: null,
      memory: [],
      knowledgeNotes: [],
      recentMessages: [],
      attachments: [],
      currentMessage: {
        id: "m1",
        chat_id: "c1",
        role: "user",
        content: "hi",
        metadata: {},
        created_at: "",
      },
      modelId: "gemini-3-flash",
    });
    expect(ctx.instructions).toContain("Runtime Policy");
    expect(ctx.instructions).toContain("Universal Agent");
    expect(ctx.instructions).toContain("UNTRUSTED CONTENT");
    expect(ctx.instructions.startsWith("\n\n## Runtime Policy")).toBe(true);
    expect(ctx.instructions.length).toBeLessThanOrEqual(CONTEXT_BUDGET.maxSystemPromptChars);
  });

  it("caps memory and does not treat a global chat as a project", () => {
    const memory = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      user_id: "u1",
      scope: "global" as const,
      project_id: null,
      content: `memory-${i} ${"word ".repeat(200)}`,
      category: null,
      source: null,
      importance: 5,
      pinned: false,
      enabled: true,
      source_run_id: null,
      confidence: null,
      evidence: [],
      learned_from: null,
      created_at: "",
      updated_at: "",
    }));
    const ctx = buildAgentContext({
      chat,
      project: null,
      preset: null,
      agentConfig,
      preferences: {
        user_id: "u1",
        personalization: { aboutMe: "Designer" },
        appearance: {},
        created_at: "",
        updated_at: "",
      },
      memory,
      knowledgeNotes: ["doc chunk"],
      recentMessages: [],
      attachments: [],
      currentMessage: {
        id: "m1",
        chat_id: "c1",
        role: "user",
        content: "hi",
        metadata: {},
        created_at: "",
      },
      modelId: "gemini-3-flash",
    });
    expect(ctx.instructions).toContain("not inside a project");
    expect(ctx.instructions).toContain("About user");
    expect(ctx.instructions.length).toBeLessThanOrEqual(CONTEXT_BUDGET.maxSystemPromptChars);
  });

  it("limits recent history", () => {
    const messages: ChatMessage[] = Array.from({ length: 50 }, (_, i) => ({
      id: String(i),
      chat_id: "c1",
      role: i % 2 ? "assistant" : "user",
      content: `msg ${i} ${"x".repeat(5000)}`,
      metadata: {},
      created_at: "",
    }));
    const history = historyToAgentMessages(messages);
    expect(history.length).toBe(CONTEXT_BUDGET.recentMessages);
    expect(String(history[0].content).length).toBeLessThanOrEqual(CONTEXT_BUDGET.maxMessageChars + 20);
  });

  it("detects vision-capable models", () => {
    expect(modelSupportsVision("gemini-3-flash")).toBe(true);
    expect(modelSupportsVision("nano-banana-2-lite")).toBe(false);
  });
});
