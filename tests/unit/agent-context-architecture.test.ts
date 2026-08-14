import { describe, expect, it } from "vitest";
import {
  buildAgentContext,
  assertCurrentUserMessage,
  assembleInstructions,
  historyToAgentMessages,
  modelSupportsVision,
  AgentContextError,
} from "@/lib/agent/context-builder";
import { AGENT_RUNTIME_POLICY, AGENT_RUNTIME_POLICY_VERSION } from "@/lib/agent/runtime-policy";
import { DEFAULT_GLOBAL_AGENT_INSTRUCTIONS } from "@/lib/agent/default-agent-instructions";
import { CONTEXT_BUDGET, AGENT_ERROR_CODES } from "@/lib/agent/config";
import { toOpenAiMessages } from "@/lib/models/kie/adapters/base";
import { toResponsesInput } from "@/lib/models/kie/adapters/base";
import { buildAnthropicMessages } from "@/lib/models/kie/adapters/kie-anthropic";
import type { AgentConfig } from "@/lib/agent/agent-config-service";
import type { Chat, ChatMessage, MemoryItem } from "@/lib/types/workspace";

const chat: Chat = {
  id: "c1",
  user_id: "u1",
  project_id: null,
  title: "Chat",
  summary: "thread summary",
  model_id: "gemini-3-6-flash",
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
  version: 3,
  created_at: "",
  updated_at: "",
};

const currentMessage: ChatMessage = {
  id: "m-current",
  chat_id: "c1",
  role: "user",
  content: "Привет",
  metadata: {},
  created_at: "",
};

function baseSources(overrides: Partial<Parameters<typeof buildAgentContext>[0]> = {}) {
  return {
    chat,
    project: null,
    preset: null,
    agentConfig,
    preferences: null,
    memory: [],
    knowledgeNotes: [],
    recentMessages: [],
    attachments: [],
    currentMessage,
    modelId: "gemini-3-6-flash",
    ...overrides,
  };
}

describe("buildAgentContext hierarchy", () => {
  it("includes runtime policy and global agent instructions", () => {
    const ctx = buildAgentContext(baseSources());
    expect(ctx.instructions).toContain("Runtime Policy");
    expect(ctx.instructions).toContain(AGENT_RUNTIME_POLICY_VERSION);
    expect(ctx.instructions).toContain("Universal Agent");
    expect(ctx.runtimePolicy.text).toBe(AGENT_RUNTIME_POLICY);
    expect(ctx.agentInstructions.text).toContain("Universal Agent");
  });

  it("adds personalization without globalInstructions field", () => {
    const ctx = buildAgentContext(
      baseSources({
        preferences: {
          user_id: "u1",
          personalization: {
            aboutMe: "Designer",
            communicationStyle: "Кратко",
            preferredLanguage: "ru",
            agentBehavior: "Предпочитаю списки",
          },
          appearance: {},
          created_at: "",
          updated_at: "",
        },
      }),
    );
    expect(ctx.instructions).toContain("About user: Designer");
    expect(ctx.instructions).toContain("Style: Кратко");
    expect(ctx.instructions).not.toContain("globalInstructions");
    expect(ctx.personalization.behaviorPreferences).toBe("Предпочитаю списки");
  });

  it("separates global and project memory", () => {
    const memory: MemoryItem[] = [
      {
        id: "1",
        user_id: "u1",
        scope: "global",
        project_id: null,
        content: "global fact",
        category: null,
        source: null,
        importance: 5,
        pinned: false,
        enabled: true,
        created_at: "",
        updated_at: "",
      },
      {
        id: "2",
        user_id: "u1",
        scope: "project",
        project_id: "p1",
        content: "project fact",
        category: null,
        source: null,
        importance: 5,
        pinned: false,
        enabled: true,
        created_at: "",
        updated_at: "",
      },
    ];
    const ctx = buildAgentContext(
      baseSources({
        memory,
        project: {
          id: "p1",
          name: "Proj",
          description: null,
          status: "active",
          default_language: "ru",
          target_platforms: [],
          system_prompt: "Project rules",
          factory_settings: {},
          created_by: "u1",
          created_at: "",
          updated_at: "",
        },
      }),
    );
    expect(ctx.globalMemory).toHaveLength(1);
    expect(ctx.projectMemory).toHaveLength(1);
    expect(ctx.instructions).toContain("Global memory");
    expect(ctx.instructions).toContain("Project memory");
    expect(ctx.instructions).toContain("Project rules");
  });

  it("includes project instructions only in project chat", () => {
    const without = buildAgentContext(baseSources());
    expect(without.instructions).toContain("not inside a project");

    const withProject = buildAgentContext(
      baseSources({
        chat: { ...chat, project_id: "p1" },
        project: {
          id: "p1",
          name: "Brand",
          description: "desc",
          status: "active",
          default_language: "ru",
          target_platforms: ["youtube"],
          system_prompt: "Always mention brand",
          factory_settings: {},
          created_by: "u1",
          created_at: "",
          updated_at: "",
        },
      }),
    );
    expect(withProject.instructions).toContain("Always mention brand");
    expect(withProject.instructions).not.toContain("not inside a project");
  });

  it("adds preset instructions in hierarchy after agent instructions", () => {
    const ctx = buildAgentContext(
      baseSources({
        preset: {
          id: "preset-1",
          user_id: "u1",
          type: "chat",
          name: "Marketing",
          is_system: false,
          is_default: false,
          settings: { systemPrompt: "Preset overlay" },
          created_at: "",
          updated_at: "",
        },
      }),
    );
    expect(ctx.instructions).toContain("Preset overlay");
    const agentIdx = ctx.instructions.indexOf("Universal Agent");
    const presetIdx = ctx.instructions.indexOf("Preset overlay");
    expect(agentIdx).toBeLessThan(presetIdx);
  });

  it("adds retrieved knowledge", () => {
    const ctx = buildAgentContext(
      baseSources({ knowledgeNotes: ["Doc A: chunk text"] }),
    );
    expect(ctx.instructions).toContain("Doc A");
    expect(ctx.retrievedKnowledge).toHaveLength(1);
  });

  it("always includes current user message as separate turn", () => {
    const ctx = buildAgentContext(baseSources());
    expect(ctx.currentTurn.content).toBe("Привет");
    expect(ctx.messages.some((m) => m.content === "Привет")).toBe(false);
    expect(ctx.manifest.current_user_message_chars).toBe("Привет".length);
  });

  it("throws when current user message is empty", () => {
    expect(() =>
      buildAgentContext(
        baseSources({
          currentMessage: { ...currentMessage, content: "   " },
        }),
      ),
    ).toThrow(AgentContextError);

    expect(() => assertCurrentUserMessage({ role: "user", content: "" })).toThrow(
      expect.objectContaining({ code: AGENT_ERROR_CODES.CURRENT_USER_MESSAGE_MISSING }),
    );
  });

  it("respects system prompt budget", () => {
    const ctx = buildAgentContext(
      baseSources({
        chat: { ...chat, summary: "x".repeat(5000) },
        knowledgeNotes: ["k".repeat(5000)],
      }),
    );
    expect(ctx.instructions.length).toBeLessThanOrEqual(CONTEXT_BUDGET.maxSystemPromptChars);
  });
});

describe("provider payload regression — current user message", () => {
  const system = assembleInstructions({
    runtimePolicy: AGENT_RUNTIME_POLICY,
    agentInstructions: DEFAULT_GLOBAL_AGENT_INSTRUCTIONS,
    presetInstructions: "",
    personalization: "",
    globalMemory: "",
    projectInstructions: "",
    projectMemory: "",
    knowledge: "",
    chatSummary: "",
  });

  it("GPT Responses payload contains Привет", () => {
    const input = toResponsesInput(system, [{ role: "user", content: "Привет" }]);
    const serialized = JSON.stringify(input);
    expect(serialized).toContain("Привет");
  });

  it("Gemini OpenAI payload contains Привет", () => {
    const messages = toOpenAiMessages(system, [{ role: "user", content: "Привет" }]);
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain("Привет");
  });

  it("Claude payload contains Привет as plain user message", () => {
    const messages = buildAnthropicMessages({
      model: "claude-sonnet-4-5",
      system,
      messages: [{ role: "user", content: "Привет" }],
      tools: [],
    });
    const last = messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toBe("Привет");
  });
});

describe("context engine utilities", () => {
  it("limits recent history", () => {
    const messages: ChatMessage[] = Array.from({ length: 50 }, (_, i) => ({
      id: String(i),
      chat_id: "c1",
      role: i % 2 ? "assistant" : "user",
      content: `msg ${i}`,
      metadata: {},
      created_at: "",
    }));
    const history = historyToAgentMessages(messages);
    expect(history.length).toBe(CONTEXT_BUDGET.recentMessages);
  });

  it("detects vision-capable models", () => {
    expect(modelSupportsVision("gemini-3-6-flash")).toBe(true);
    expect(modelSupportsVision("nano-banana-2-lite")).toBe(false);
  });
});
