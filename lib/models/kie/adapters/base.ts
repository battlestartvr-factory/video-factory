import type { AgentMessage, AgentProviderResponse, AgentRequest, AgentToolCall } from "@/lib/agent/types";
import type { KieModelEntry } from "../types";
import { normalizeKieError } from "../errors";
import { resolveReasoning } from "../reasoning";

export interface KieAdapterContext {
  baseUrl: string;
  apiKey: string;
  model: KieModelEntry;
  reasoningLevel?: string | null;
}

export interface KieAdapter {
  run(ctx: KieAdapterContext, input: AgentRequest): Promise<AgentProviderResponse>;
}

export function joinKieUrl(baseUrl: string, endpoint: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${base}${path}`;
}

export function parseToolCalls(raw: unknown): AgentToolCall[] {
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

export function toOpenAiMessages(system: string, messages: AgentMessage[]) {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content:
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
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

export function parseStructuredFallback(content: string | null): {
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

export async function kieFetch(
  ctx: KieAdapterContext,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Response> {
  const url = joinKieUrl(ctx.baseUrl, ctx.model.endpoint);
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export function buildReasoningBody(ctx: KieAdapterContext): Record<string, unknown> {
  if (!ctx.reasoningLevel) return {};
  const resolved = resolveReasoning(ctx.model, ctx.reasoningLevel as never);
  return resolved.providerParam;
}

export async function handleKieResponse(
  response: Response,
  extractMessage: (payload: unknown) => {
    content?: string | null;
    tool_calls?: unknown;
    finish_reason?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  },
): Promise<AgentProviderResponse> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw normalizeKieError(response.status, text);
  }
  const payload = await response.json();
  const message = extractMessage(payload);
  let content = message.content ?? null;
  let toolCalls = parseToolCalls(message.tool_calls);
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
      promptTokens: message.usage?.prompt_tokens,
      completionTokens: message.usage?.completion_tokens,
      totalTokens: message.usage?.total_tokens,
    },
    finishReason:
      message.finish_reason === "tool_calls" || toolCalls.length ? "tool_calls" : "stop",
  };
}
