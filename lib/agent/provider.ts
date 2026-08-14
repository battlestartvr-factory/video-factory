import "server-only";
import { getAgentLlmConfig } from "@/lib/env/env.server";
import { AGENT_ERROR_CODES, AGENT_PROVIDER_TIMEOUT_MS } from "./config";
import type {
  AgentMessage,
  AgentProvider,
  AgentProviderResponse,
  AgentRequest,
  AgentToolCall,
} from "./types";

export class AgentProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentProviderError";
  }
}

class NotConfiguredAgentProvider implements AgentProvider {
  async run(): Promise<AgentProviderResponse> {
    throw new AgentProviderError(
      AGENT_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
      "Agent LLM provider is not configured",
    );
  }
}

function toOpenAiMessages(system: string, messages: AgentMessage[]) {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: message.content ?? null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        })),
      });
      continue;
    }
    out.push({
      role: message.role,
      content: message.content,
    });
  }
  return out;
}

function parseToolCalls(raw: unknown): AgentToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: AgentToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as {
      id?: string;
      function?: { name?: string; arguments?: string };
      name?: string;
      arguments?: unknown;
    };
    const name = row.function?.name ?? row.name;
    if (!name) continue;
    let args: Record<string, unknown> = {};
    const rawArgs = row.function?.arguments ?? row.arguments;
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch {
        args = {};
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs as Record<string, unknown>;
    }
    calls.push({
      id: row.id ?? crypto.randomUUID(),
      name,
      arguments: args,
    });
  }
  return calls;
}

function parseStructuredFallback(content: string | null): {
  content: string | null;
  toolCalls: AgentToolCall[];
} {
  if (!content) return { content, toolCalls: [] };
  const match = content.match(/\{[\s\S]*"tool_calls"[\s\S]*\}/);
  if (!match) return { content, toolCalls: [] };
  try {
    const parsed = JSON.parse(match[0]) as {
      content?: string | null;
      tool_calls?: Array<{ name: string; arguments?: Record<string, unknown>; id?: string }>;
    };
    if (!Array.isArray(parsed.tool_calls)) return { content, toolCalls: [] };
    return {
      content: parsed.content ?? null,
      toolCalls: parsed.tool_calls.map((call) => ({
        id: call.id ?? crypto.randomUUID(),
        name: call.name,
        arguments: call.arguments ?? {},
      })),
    };
  } catch {
    return { content, toolCalls: [] };
  }
}

export class OpenAiCompatibleAgentProvider implements AgentProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async run(input: AgentRequest): Promise<AgentProviderResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: toOpenAiMessages(input.system, input.messages),
        tools: input.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
        tool_choice: "auto",
        temperature: 0.4,
      }),
      signal: AbortSignal.timeout(AGENT_PROVIDER_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new AgentProviderError("AGENT_PROVIDER_ERROR", `Provider returned ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: unknown;
        };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    const message = payload.choices?.[0]?.message;
    const finish = payload.choices?.[0]?.finish_reason;
    let content = message?.content ?? null;
    let toolCalls = parseToolCalls(message?.tool_calls);
    if (!toolCalls.length && content) {
      const fallback = parseStructuredFallback(content);
      if (fallback.toolCalls.length) {
        toolCalls = fallback.toolCalls;
        content = fallback.content;
      }
    }

    return {
      content,
      toolCalls,
      usage: {
        promptTokens: payload.usage?.prompt_tokens,
        completionTokens: payload.usage?.completion_tokens,
        totalTokens: payload.usage?.total_tokens,
      },
      finishReason: finish === "tool_calls" || toolCalls.length ? "tool_calls" : "stop",
    };
  }
}

export function createAgentProvider(): AgentProvider {
  const config = getAgentLlmConfig();
  if (!config.configured) return new NotConfiguredAgentProvider();
  return new OpenAiCompatibleAgentProvider(config.baseUrl, config.apiKey);
}

export function resolveAgentModel(requested?: string | null): { model: string; allowed: boolean } {
  const config = getAgentLlmConfig();
  const requestedModel = requested?.trim();
  const allowed = config.allowedModels;
  if (requestedModel) {
    if (!allowed.length || allowed.includes(requestedModel) || requestedModel === config.defaultModel) {
      return { model: requestedModel, allowed: true };
    }
    return { model: config.defaultModel, allowed: false };
  }
  return { model: config.defaultModel, allowed: true };
}

export { parseToolCalls, parseStructuredFallback, toOpenAiMessages };
