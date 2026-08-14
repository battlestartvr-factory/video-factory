import type { AgentMessage, AgentProviderResponse, AgentRequest, AgentToolCall } from "@/lib/agent/types";
import type { KieModelEntry } from "../types";
import {
  classifyKieHttpStatus,
  describeRequestPayloadShape,
  logKieProviderError,
  normalizeKieError,
  parseKieErrorBody,
  type KieResponseParseStage,
} from "../errors";
import { resolveReasoning } from "../reasoning";

export interface KieAdapterContext {
  baseUrl: string;
  apiKey: string;
  model: KieModelEntry;
  reasoningLevel?: string | null;
  agentRunId?: string | null;
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
      call_id?: string;
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
      id: row.id ?? row.call_id ?? crypto.randomUUID(),
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

/** Converts agent history to OpenAI Responses API input items (not Chat Completions). */
export function toResponsesInput(system: string, messages: AgentMessage[]): unknown[] {
  const input: unknown[] = [];

  if (system.trim()) {
    input.push({
      role: "system",
      content: [{ type: "input_text", text: system }],
    });
  }

  for (const message of messages) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output:
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      });
      continue;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      if (message.content) {
        const text =
          typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        input.push({
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      for (const call of message.toolCalls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {}),
        });
      }
      continue;
    }

    if (message.role === "user" || message.role === "assistant") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
            ? JSON.stringify(message.content)
            : "";
      if (!text) continue;
      const contentType = message.role === "assistant" ? "output_text" : "input_text";
      input.push({
        role: message.role,
        content: [{ type: contentType, text }],
      });
    }
  }

  return input;
}

export function extractText(content: AgentMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text!)
    .join("");
}

/** Converts agent history to KIE Claude Messages format (plain string content). */
export function toClaudeMessages(messages: AgentMessage[]) {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: (m.role === "tool" ? "user" : m.role) as "user" | "assistant",
      content: extractText(m.content),
    }))
    .filter((m) => m.content.length > 0);
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

function isEventStream(contentType: string, body: string): boolean {
  return (
    contentType.includes("text/event-stream") ||
    contentType.includes("application/stream+json") ||
    body.trimStart().startsWith("data:")
  );
}

function parseSsePayload(body: string): unknown {
  const events: unknown[] = [];
  let lastJson: unknown = null;

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      events.push(parsed);
      lastJson = parsed;

      if (parsed.type === "response.completed" && parsed.response) {
        return parsed.response;
      }
      if (parsed.response && typeof parsed.response === "object") {
        lastJson = parsed.response;
      }
    } catch {
      // skip malformed SSE lines
    }
  }

  if (lastJson && typeof lastJson === "object") {
    const obj = lastJson as Record<string, unknown>;
    if (obj.output || obj.choices || obj.content) return lastJson;
  }

  if (events.length === 1) return events[0];
  return { output: events };
}

export async function parseKieResponseBody(
  response: Response,
): Promise<{ payload: unknown; contentType: string; parseStage: KieResponseParseStage }> {
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text().catch(() => "");

  if (isEventStream(contentType, body)) {
    return { payload: parseSsePayload(body), contentType, parseStage: "sse_assembled" };
  }

  if (!body.trim()) {
    return { payload: {}, contentType, parseStage: "empty_body" };
  }

  try {
    return { payload: JSON.parse(body), contentType, parseStage: "json" };
  } catch {
    return { payload: body, contentType, parseStage: "json_parse_failed" };
  }
}

export async function handleKieResponse(
  ctx: KieAdapterContext,
  response: Response,
  extractMessage: (payload: unknown) => {
    content?: string | null;
    tool_calls?: unknown;
    finish_reason?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  },
  options?: { requestBody?: Record<string, unknown> },
): Promise<AgentProviderResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  const requestPayloadShape = options?.requestBody
    ? describeRequestPayloadShape(options.requestBody)
    : undefined;

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = normalizeKieError(response.status, text, contentType, ctx.model.adapter);
    const parsed = parseKieErrorBody(text);
    logKieProviderError({
      model_id: ctx.model.id,
      adapter: ctx.model.adapter,
      endpoint: ctx.model.endpoint,
      http_status: response.status,
      content_type: contentType || undefined,
      http_error_category: classifyKieHttpStatus(response.status),
      normalized_error_code: error.code,
      response_parse_stage: "error_body",
      agent_run_id: ctx.agentRunId ?? undefined,
      response_body: text || undefined,
      request_payload_shape: requestPayloadShape,
      ...parsed,
    });
    throw error;
  }

  const { payload, parseStage } = await parseKieResponseBody(response);

  if (parseStage === "json_parse_failed") {
    logKieProviderError({
      model_id: ctx.model.id,
      adapter: ctx.model.adapter,
      endpoint: ctx.model.endpoint,
      http_status: response.status,
      content_type: contentType || undefined,
      http_error_category: "provider_failure",
      normalized_error_code: "RESPONSE_PARSE_ERROR",
      response_parse_stage: parseStage,
      agent_run_id: ctx.agentRunId ?? undefined,
    });
    throw normalizeKieError(502, "Invalid JSON response", contentType);
  }

  let message: ReturnType<typeof extractMessage>;
  try {
    message = extractMessage(payload);
  } catch {
    logKieProviderError({
      model_id: ctx.model.id,
      adapter: ctx.model.adapter,
      endpoint: ctx.model.endpoint,
      http_status: response.status,
      content_type: contentType || undefined,
      http_error_category: "provider_failure",
      normalized_error_code: "RESPONSE_PARSE_ERROR",
      response_parse_stage: "extract_message",
      agent_run_id: ctx.agentRunId ?? undefined,
    });
    throw normalizeKieError(502, "Failed to extract provider message", contentType);
  }

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
