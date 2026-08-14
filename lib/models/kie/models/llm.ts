import type { KieModelEntry } from "../types";

const EFFORT_REASONING = {
  control: "effort" as const,
  levels: ["low", "medium", "high", "max"] as const,
  default: "medium" as const,
  mapping: {
    low: "low",
    medium: "medium",
    high: "high",
    max: "high",
  },
};

export const LLM_MODELS: KieModelEntry[] = [
  {
    id: "gemini-3-6-flash",
    displayName: "Gemini 3.6 Flash",
    provider: "kie",
    category: "llm",
    adapter: "openai_chat",
    endpoint: "/gemini-3-6-flash/v1/chat/completions",
    providerModel: "gemini-3-6-flash",
    capabilities: {
      chat: true,
      vision: true,
      toolCalling: true,
    },
    reasoning: {
      control: "effort",
      levels: ["low", "medium", "high"],
      default: "medium",
      mapping: { low: "low", medium: "medium", high: "high", max: "high" },
    },
    defaults: { isDefault: true },
    enabled: true,
    aliases: ["gemini-3-flash"],
    useCases: [
      "обычный Universal Agent",
      "tool calling",
      "быстрые запросы",
      "простые исследования",
      "vision",
    ],
  },
  {
    id: "gemini-3-pro",
    displayName: "Gemini 3 Pro",
    provider: "kie",
    category: "llm",
    adapter: "openai_chat",
    endpoint: "/gemini-3-pro/v1/chat/completions",
    providerModel: "gemini-3-pro",
    capabilities: {
      chat: true,
      vision: true,
      toolCalling: true,
    },
    reasoning: {
      control: "effort",
      levels: ["low", "medium", "high"],
      default: "medium",
      mapping: { low: "low", medium: "medium", high: "high", max: "high" },
    },
    enabled: true,
    useCases: [
      "сложный анализ",
      "research",
      "multimodal analysis",
      "более сложное планирование",
    ],
  },
  {
    id: "gpt-5-6-sol",
    displayName: "GPT 5.6 Sol",
    provider: "kie",
    category: "llm",
    adapter: "responses",
    endpoint: "/v1/responses",
    providerModel: "gpt-5-6-sol",
    capabilities: {
      chat: true,
      vision: true,
      toolCalling: true,
    },
    reasoning: {
      control: "effort",
      levels: ["low", "medium", "high", "max"],
      default: "medium",
      mapping: { low: "low", medium: "medium", high: "high", max: "xhigh" },
    },
    enabled: true,
    useCases: [
      "сложный reasoning",
      "multi-step agent tasks",
      "сложный research",
      "важные решения",
    ],
  },
  {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    provider: "kie",
    category: "llm",
    adapter: "claude_messages",
    endpoint: "/v1/messages",
    providerModel: "claude-sonnet-5",
    capabilities: {
      chat: true,
      vision: true,
      toolCalling: true,
    },
    reasoning: {
      control: "binary",
      levels: ["off", "on"],
      default: "on",
      mapping: { off: "disabled", on: "enabled" },
    },
    enabled: true,
    useCases: [
      "creative writing",
      "сценарии",
      "посты",
      "структурирование",
      "длинные тексты",
      "agentic work",
    ],
  },
  {
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    provider: "kie",
    category: "llm",
    adapter: "claude_messages",
    endpoint: "/v1/messages",
    providerModel: "claude-opus-5",
    capabilities: {
      chat: true,
      vision: true,
      toolCalling: true,
    },
    reasoning: {
      control: "adaptive",
      levels: ["off", "on"],
      default: "on",
      mapping: { off: "disabled", on: "adaptive" },
    },
    enabled: true,
    useCases: [
      "максимально сложные задачи",
      "long-horizon reasoning",
      "большие исследования",
      "сложная структура",
    ],
  },
];

// Suppress unused variable warning — kept for reference in docs
void EFFORT_REASONING;
