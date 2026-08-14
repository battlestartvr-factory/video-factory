import { AGENT_ERROR_CODES, AGENT_PROVIDER_TIMEOUT_MS } from "@/lib/agent/config";
import type {
  AgentMessage,
  AgentProviderResponse,
  AgentRequest,
  AgentToolCall,
} from "@/lib/agent/types";
import {
  classifyKieHttpStatus,
  KieProviderError,
  logKieProviderError,
  normalizeKieError,
  parseKieErrorBody,
} from "../errors";
import type { KieAdapter, KieAdapterContext } from "./base";
import { joinKieUrl } from "./base";

const CLAUDE_ENDPOINT = "/claude/v1/messages";
const CLAUDE_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 4096;

type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export type ClaudeSonnetMessage = {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
};

export function extractMessageText(content: AgentMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text!)
    .join("");
}

function messageContentLength(content: string | ClaudeContentBlock[]): number {
  if (typeof content === "string") return content.trim().length;
  return content.reduce((sum, block) => {
    if (block.type === "text") return sum + block.text.trim().length;
    if (block.type === "tool_result") return sum + block.content.trim().length;
    return sum + 1;
  }, 0);
}

function buildEnvelopeContent(system: string, userText: string): string {
  return `<agent_instructions>\n${system.trim()}\n</agent_instructions>\n\n<user_request>\n${userText.trim()}\n</user_request>`;
}

function convertAssistantMessage(message: AgentMessage): ClaudeSonnetMessage {
  const text = extractMessageText(message.content);
  if (message.toolCalls?.length) {
    const blocks: ClaudeContentBlock[] = [];
    if (text.trim()) blocks.push({ type: "text", text });
    for (const call of message.toolCalls) {
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.arguments ?? {},
      });
    }
    return { role: "assistant", content: blocks };
  }
  return { role: "assistant", content: text };
}

function convertToolMessage(message: AgentMessage): ClaudeSonnetMessage {
  const resultText =
    typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? {});
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: resultText,
      },
    ],
  };
}

/** Builds KIE Claude messages from agent history + current user turn. */
export function buildClaudeSonnetMessages(input: AgentRequest): ClaudeSonnetMessage[] {
  const result: ClaudeSonnetMessage[] = [];
  let envelopedFirstUser = false;

  for (const message of input.messages) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      result.push(convertToolMessage(message));
      continue;
    }

    if (message.role === "assistant") {
      const converted = convertAssistantMessage(message);
      if (messageContentLength(converted.content) > 0) {
        result.push(converted);
      }
      continue;
    }

    if (message.role === "user") {
      const text = extractMessageText(message.content);
      if (!text.trim()) continue;

      if (!envelopedFirstUser) {
        result.push({
          role: "user",
          content: buildEnvelopeContent(input.system, text),
        });
        envelopedFirstUser = true;
      } else {
        result.push({ role: "user", content: text });
      }
    }
  }

  return result;
}

export function assertClaudeMessagesNonEmpty(messages: ClaudeSonnetMessage[]): void {
  const hasUserContent = messages.some(
    (message) => message.role === "user" && messageContentLength(message.content) > 0,
  );
  if (!hasUserContent) {
    throw new KieProviderError(
      AGENT_ERROR_CODES.CLAUDE_EMPTY_MESSAGES,
      "Claude request has no user messages",
    );
  }
}

export function buildClaudeSonnetTools(tools: AgentRequest["tools"]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export function resolveClaudeThinkingFlag(
  ctx: KieAdapterContext,
): { thinkingMode: "standard" | "thinking"; thinkingFlag?: true } {
  const level = ctx.reasoningLevel ?? "standard";
  const normalized =
    level === "on" || level === "thinking" || level === "high" || level === "max"
      ? "thinking"
      : "standard";
  if (normalized === "thinking") {
    return { thinkingMode: "thinking", thinkingFlag: true };
  }
  return { thinkingMode: "standard" };
}

export function buildClaudeSonnetRequestBody(
  input: AgentRequest,
  ctx: KieAdapterContext,
): {
  body: Record<string, unknown>;
  messages: ClaudeSonnetMessage[];
  thinkingMode: "standard" | "thinking";
  toolsCount: number;
} {
  const messages = buildClaudeSonnetMessages(input);
  assertClaudeMessagesNonEmpty(messages);

  const { thinkingMode, thinkingFlag } = resolveClaudeThinkingFlag(ctx);
  const tools = buildClaudeSonnetTools(input.tools);

  const body: Record<string, unknown> = {
    model: CLAUDE_MODEL,
    messages,
    stream: false,
    max_tokens: MAX_TOKENS,
  };

  if (thinkingFlag === true) {
    body.thinkingFlag = true;
  }

  if (tools.length > 0) {
    body.tools = tools;
  }

  return { body, messages, thinkingMode, toolsCount: tools.length };
}

export function parseClaudeSonnetResponse(payload: unknown): {
  content: string | null;
  toolCalls: AgentToolCall[];
  finishReason: "stop" | "tool_calls";
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
} {
  const p = payload as {
    content?: Array<{
      type?: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string;
  };

  const text = (p.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");

  const toolCalls: AgentToolCall[] = (p.content ?? [])
    .filter((block) => block.type === "tool_use")
    .map((block) => ({
      id: block.id ?? crypto.randomUUID(),
      name: block.name ?? "",
      arguments: block.input ?? {},
    }));

  const finishReason =
    p.stop_reason === "tool_use" || toolCalls.length ? "tool_calls" : "stop";

  return {
    content: text || null,
    toolCalls,
    finishReason,
    usage: {
      prompt_tokens: p.usage?.input_tokens,
      completion_tokens: p.usage?.output_tokens,
      total_tokens: (p.usage?.input_tokens ?? 0) + (p.usage?.output_tokens ?? 0),
    },
  };
}

function lastMessageDiagnostics(messages: ClaudeSonnetMessage[]) {
  const last = messages[messages.length - 1];
  if (!last) {
    return { last_message_role: undefined, last_message_chars: 0 };
  }
  return {
    last_message_role: last.role,
    last_message_chars: messageContentLength(last.content),
  };
}

function logClaudeRequestDiagnostics(input: {
  model: string;
  endpoint: string;
  http_status?: number;
  messages_count: number;
  last_message_role?: string;
  last_message_chars: number;
  thinking_mode: string;
  tools_count: number;
  provider_error_body?: string;
}) {
  console.info("kie_claude_sonnet_request", input);
}

export class KieClaudeSonnetAdapter implements KieAdapter {
  async run(ctx: KieAdapterContext, input: AgentRequest): Promise<AgentProviderResponse> {
    const { body, messages, thinkingMode, toolsCount } = buildClaudeSonnetRequestBody(input, ctx);
    const url = joinKieUrl(ctx.baseUrl, CLAUDE_ENDPOINT);
    const lastDiag = lastMessageDiagnostics(messages);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AGENT_PROVIDER_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const contentType = response.headers.get("content-type") ?? "";
      const error = normalizeKieError(response.status, text, contentType, "claude_sonnet");
      const parsed = parseKieErrorBody(text);

      logClaudeRequestDiagnostics({
        model: CLAUDE_MODEL,
        endpoint: CLAUDE_ENDPOINT,
        http_status: response.status,
        messages_count: messages.length,
        ...lastDiag,
        thinking_mode: thinkingMode,
        tools_count: toolsCount,
        provider_error_body: text ? text.slice(0, 4096) : undefined,
      });

      logKieProviderError({
        model_id: ctx.model.id,
        adapter: ctx.model.adapter,
        endpoint: CLAUDE_ENDPOINT,
        http_status: response.status,
        content_type: contentType || undefined,
        http_error_category: classifyKieHttpStatus(response.status),
        normalized_error_code: error.code,
        response_parse_stage: "error_body",
        agent_run_id: ctx.agentRunId ?? undefined,
        response_body: text || undefined,
        ...parsed,
      });
      throw error;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const rawBody = await response.text().catch(() => "");

    logClaudeRequestDiagnostics({
      model: CLAUDE_MODEL,
      endpoint: CLAUDE_ENDPOINT,
      http_status: response.status,
      messages_count: messages.length,
      ...lastDiag,
      thinking_mode: thinkingMode,
      tools_count: toolsCount,
    });

    let payload: unknown;
    try {
      payload = rawBody.trim() ? JSON.parse(rawBody) : {};
    } catch {
      throw normalizeKieError(502, "Invalid JSON response", contentType, "claude_sonnet");
    }

    const parsed = parseClaudeSonnetResponse(payload);
    return {
      content: parsed.content,
      toolCalls: parsed.toolCalls,
      usage: {
        promptTokens: parsed.usage.prompt_tokens,
        completionTokens: parsed.usage.completion_tokens,
        totalTokens: parsed.usage.total_tokens,
      },
      finishReason: parsed.finishReason,
    };
  }
}

export const kieClaudeSonnetAdapter = new KieClaudeSonnetAdapter();
