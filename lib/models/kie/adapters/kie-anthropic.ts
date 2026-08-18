import { AGENT_ERROR_CODES, AGENT_PROVIDER_TIMEOUT_MS } from "@/lib/agent/config";
import type {
  AgentContentPart,
  AgentMessage,
  AgentProviderResponse,
  AgentRequest,
  AgentToolCall,
} from "@/lib/agent/types";
import { KieProviderError } from "../errors";
import type { KieAdapter, KieAdapterContext } from "./base";
import { handleKieResponse, joinKieUrl } from "./base";

const MAX_TOKENS = 8192;
const CLAUDE_ANTHROPIC_BASE_PATH = "/claude";
const ANTHROPIC_VERSION = "2023-06-01";

type ClaudeTextBlock = { type: "text"; text: string };
type ClaudeImageBlock = {
  type: "image";
  source: { type: "url"; url: string };
};
type ClaudeToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
type ClaudeToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeImageBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock;

export type ClaudeMessageParam = {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
};

export type ClaudeTool = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
};

export type ClaudeRequestBody = {
  model: string;
  max_tokens: number;
  messages: ClaudeMessageParam[];
  stream: false;
  system?: string;
  tools?: ClaudeTool[];
  thinkingFlag?: true;
};

export function buildKieAnthropicBaseUrl(kieRootUrl: string): string {
  return joinKieUrl(kieRootUrl, CLAUDE_ANTHROPIC_BASE_PATH);
}

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

function convertUserContent(message: AgentMessage): string | ClaudeContentBlock[] {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";

  const blocks: ClaudeContentBlock[] = [];
  for (const part of message.content as AgentContentPart[]) {
    if (part.type === "text" && part.text) {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url" && part.image_url?.url) {
      blocks.push({
        type: "image",
        source: { type: "url", url: part.image_url.url },
      });
    }
  }

  return blocks.length === 1 && blocks[0]?.type === "text" ? blocks[0].text : blocks;
}

function convertAssistantMessage(message: AgentMessage): ClaudeMessageParam {
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

function convertToolMessage(message: AgentMessage): ClaudeMessageParam {
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

/**
 * Build Claude Messages API history. System instructions are deliberately kept out of
 * `messages`; KIE's Claude proxy accepts the native top-level `system` field.
 */
export function buildAnthropicMessages(input: AgentRequest): ClaudeMessageParam[] {
  const result: ClaudeMessageParam[] = [];

  for (const message of input.messages) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      result.push(convertToolMessage(message));
      continue;
    }

    if (message.role === "assistant") {
      const converted = convertAssistantMessage(message);
      if (messageContentLength(converted.content) > 0) result.push(converted);
      continue;
    }

    if (message.role === "user") {
      const content = convertUserContent(message);
      if (messageContentLength(content) === 0) continue;
      result.push({ role: "user", content });
    }
  }

  return result;
}

export function assertAnthropicMessagesNonEmpty(messages: ClaudeMessageParam[]): void {
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

function normalizeAnthropicInputSchema(
  parameters: Record<string, unknown>,
): ClaudeTool["input_schema"] {
  if (parameters.type !== "object") {
    throw new KieProviderError(
      AGENT_ERROR_CODES.CLAUDE_TOOL_SCHEMA_UNSUPPORTED,
      "Claude tool schema must have type object",
    );
  }

  const properties =
    parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
      ? (parameters.properties as Record<string, unknown>)
      : {};

  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((item): item is string => typeof item === "string")
    : [];

  return { type: "object", properties, required };
}

export function toAnthropicTool(tool: AgentRequest["tools"][number]): ClaudeTool {
  if (!tool.name?.trim()) {
    throw new KieProviderError(
      AGENT_ERROR_CODES.CLAUDE_TOOL_SCHEMA_UNSUPPORTED,
      "Claude tool must have a name",
    );
  }
  if (!tool.description?.trim()) {
    throw new KieProviderError(
      AGENT_ERROR_CODES.CLAUDE_TOOL_SCHEMA_UNSUPPORTED,
      `Claude tool ${tool.name} must have a description`,
    );
  }

  const maybeOpenAi = tool as unknown as Record<string, unknown>;
  if (maybeOpenAi.type === "function" || maybeOpenAi.function) {
    throw new KieProviderError(
      AGENT_ERROR_CODES.CLAUDE_TOOL_SCHEMA_UNSUPPORTED,
      "OpenAI function wrapper is not supported for Claude",
    );
  }

  const schemaSource =
    "input_schema" in tool && tool.input_schema && typeof tool.input_schema === "object"
      ? (tool.input_schema as Record<string, unknown>)
      : tool.parameters;

  return {
    name: tool.name,
    description: tool.description,
    input_schema: normalizeAnthropicInputSchema(schemaSource),
  };
}

export function buildAnthropicTools(tools: AgentRequest["tools"]): ClaudeTool[] {
  return tools.map((tool) => toAnthropicTool(tool));
}

export function resolveAnthropicThinkingMode(
  ctx: KieAdapterContext,
): { thinkingMode: "standard" | "thinking"; thinkingFlag?: true } {
  const level = ctx.reasoningLevel ?? "standard";
  const normalized =
    level === "on" || level === "thinking" || level === "high" || level === "max"
      ? "thinking"
      : "standard";
  if (normalized === "thinking") return { thinkingMode: "thinking", thinkingFlag: true };
  return { thinkingMode: "standard" };
}

export function buildAnthropicRequestParams(
  input: AgentRequest,
  ctx: KieAdapterContext,
): {
  params: ClaudeRequestBody;
  messages: ClaudeMessageParam[];
  thinkingMode: "standard" | "thinking";
  toolsCount: number;
  systemChars: number;
  currentUserChars: number;
  lastMessageChars: number;
} {
  const messages = buildAnthropicMessages(input);
  assertAnthropicMessagesNonEmpty(messages);

  const { thinkingMode, thinkingFlag } = resolveAnthropicThinkingMode(ctx);
  const tools = buildAnthropicTools(input.tools);
  const system = input.system.trim() || undefined;

  const params: ClaudeRequestBody = {
    model: ctx.model.providerModel,
    max_tokens: MAX_TOKENS,
    messages,
    stream: false,
    ...(system ? { system } : {}),
    ...(tools.length ? { tools } : {}),
    ...(thinkingFlag === true ? { thinkingFlag: true } : {}),
  };

  const lastMessage = messages[messages.length - 1];
  const lastUser = [...messages].reverse().find((message) => message.role === "user");

  return {
    params,
    messages,
    thinkingMode,
    toolsCount: tools.length,
    systemChars: input.system.trim().length,
    currentUserChars: lastUser ? messageContentLength(lastUser.content) : 0,
    lastMessageChars: lastMessage ? messageContentLength(lastMessage.content) : 0,
  };
}

function extractClaudeResponse(payload: unknown): {
  content?: string | null;
  tool_calls?: unknown;
  finish_reason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
} {
  if (!payload || typeof payload !== "object") {
    throw new Error("Claude response is not an object");
  }

  const response = payload as {
    content?: unknown;
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const blocks = Array.isArray(response.content) ? response.content : [];
  const text = blocks
    .filter(
      (block): block is { type: "text"; text: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");

  const toolCalls = blocks
    .filter(
      (block): block is {
        type: "tool_use";
        id: string;
        name: string;
        input?: Record<string, unknown>;
      } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "tool_use" &&
        typeof (block as { id?: unknown }).id === "string" &&
        typeof (block as { name?: unknown }).name === "string",
    )
    .map((block) => ({
      id: block.id,
      name: block.name,
      arguments: block.input ?? {},
    } satisfies AgentToolCall));

  const inputTokens = response.usage?.input_tokens;
  const outputTokens = response.usage?.output_tokens;

  return {
    content: text || null,
    tool_calls: toolCalls,
    finish_reason: response.stop_reason === "tool_use" || toolCalls.length ? "tool_calls" : "stop",
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens:
        typeof inputTokens === "number" && typeof outputTokens === "number"
          ? inputTokens + outputTokens
          : undefined,
    },
  };
}

async function kieClaudeFetch(ctx: KieAdapterContext, body: ClaudeRequestBody): Promise<Response> {
  return fetch(joinKieUrl(ctx.baseUrl, ctx.model.endpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.apiKey}`,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AGENT_PROVIDER_TIMEOUT_MS),
  });
}

/**
 * KIE Claude Messages API adapter.
 *
 * This intentionally uses KIE's documented wire contract directly rather than the
 * Anthropic SDK. It prevents SDK auth/base-URL behavior from changing the request and
 * makes the exact model id, headers and payload visible in our own tests and logs.
 */
export class KieAnthropicProvider implements KieAdapter {
  async run(ctx: KieAdapterContext, input: AgentRequest): Promise<AgentProviderResponse> {
    const { params } = buildAnthropicRequestParams(input, ctx);
    const response = await kieClaudeFetch(ctx, params);
    return handleKieResponse(ctx, response, extractClaudeResponse, { requestBody: params });
  }
}

export const kieAnthropicProvider = new KieAnthropicProvider();
