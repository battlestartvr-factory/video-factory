import { describe, expect, it } from "vitest";
import { assembleSystemPrompt, historyToAgentMessages, modelSupportsVision } from "@/lib/agent/context-builder";
import { CONTEXT_BUDGET } from "@/lib/agent/config";
import { BASE_AGENT_INSTRUCTIONS } from "@/lib/agent/system-prompt";
import type { Chat, ChatMessage, MemoryItem } from "@/lib/types/workspace";

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

describe("context engine", () => {
  it("includes base instructions and injection warning", () => {
    const prompt = assembleSystemPrompt({
      chat,
      project: null,
      preset: null,
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
    expect(prompt).toContain("Universal Agent");
    expect(prompt).toContain("UNTRUSTED CONTENT");
    expect(prompt.startsWith(BASE_AGENT_INSTRUCTIONS.slice(0, 40))).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(CONTEXT_BUDGET.maxSystemPromptChars);
  });

  it("caps memory and does not treat a global chat as a project", () => {
    const memory: MemoryItem[] = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      user_id: "u1",
      scope: "global",
      project_id: null,
      content: `memory-${i} ${"word ".repeat(200)}`,
      category: null,
      source: null,
      importance: 5,
      pinned: false,
      enabled: true,
      created_at: "",
      updated_at: "",
    }));
    const prompt = assembleSystemPrompt({
      chat,
      project: null,
      preset: null,
      preferences: {
        user_id: "u1",
        personalization: { aboutMe: "Designer", globalInstructions: "Be brief" },
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
    expect(prompt).toContain("not inside a project");
    expect(prompt).toContain("About user");
    expect(prompt.length).toBeLessThanOrEqual(CONTEXT_BUDGET.maxSystemPromptChars);
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
