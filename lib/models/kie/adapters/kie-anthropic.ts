import Anthropic, { APIError } from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { AGENT_ERROR_CODES, AGENT_PROVIDER_TIMEOUT_MS } from "@/lib/agent/config";
import type {
  AgentContentPart,
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

const MAX_TOKENS = 4096;
const CLAUDE_ANTHROPIC_BASE_PATH = "/claude";

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

function messageContentLength(content: string | ContentBlockParam[]): number {
  if (typeof content === "string") return content.trim().length;
  return content.reduce((sum, block) => {
    if (block.type === "text") return sum + (block.text?.trim().length ?? 0);
    if (block.type === "tool_result") {
      const toolContent = block.content;
      if (typeof toolContent === "string") return sum + toolContent.trim().length;
      return sum + 1;
    }
    return sum + 1;
  }, 0);
}

function convertUserContent(message: AgentMessage): string | ContentBlockParam[] {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";

  const blocks: ContentBlockParam[] = [];
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

function convertAssistantMessage(message: AgentMessage): MessageParam {
  const text = extractMessageText(message.content);
  if (message.toolCalls?.length) {
    const blocks: ContentBlockParam[] = [];
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

function convertToolMessage(message: AgentMessage): MessageParam {
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

/** Builds Anthropic messages from agent history + current user turn (system stays separate). */
export function buildAnthropicMessages(input: AgentRequest): MessageParam[] {
  const result: MessageParam[] = [];

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
      const content = convertUserContent(message);
      if (messageContentLength(content) === 0) continue;
      result.push({ role: "user", content });
    }
  }

  return result;
}

export function assertAnthropicMessagesNonEmpty(messages: MessageParam[]): void {
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
): Tool["input_schema"] {
  const type = parameters.type;
  if (type !== "object") {
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

export function toAnthropicTool(tool: AgentRequest["tools"][number]): Tool {
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

export function buildAnthropicTools(tools: AgentRequest["tools"]): Tool[] {
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
  if (normalized === "thinking") {
    return { thinkingMode: "thinking", thinkingFlag: true };
  }
  return { thinkingMode: "standard" };
}

export function buildAnthropicRequestParams(
  input: AgentRequest,
  ctx: KieAdapterContext,
): {
  params: MessageCreateParamsNonStreaming & { thinkingFlag?: true };
  messages: MessageParam[];
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

  const params: MessageCreateParamsNonStreaming & { thinkingFlag?: true } = {
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

function parseAnthropicResponse(message: Anthropic.Message): {
  content: string | null;
  toolCalls: AgentToolCall[];
  finishReason: "stop" | "tool_calls";
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
} {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  const toolCalls: AgentToolCall[] = message.content
    .filter((block) => block.type === "tool_use")
    .map((block) => ({
      id: block.id,
      name: block.name,
      arguments: (block.input ?? {}) as Record<string, unknown>,
    }));

  const finishReason =
    message.stop_reason === "tool_use" || toolCalls.length ? "tool_calls" : "stop";

  return {
    content: text || null,
    toolCalls,
    finishReason,
    usage: {
      prompt_tokens: message.usage.input_tokens,
      completion_tokens: message.usage.output_tokens,
      total_tokens: message.usage.input_tokens + message.usage.output_tokens,
    },
  };
}

function logAnthropicRequestDiagnostics(input: {
  model: string;
  endpoint: string;
  http_status?: number;
  messages_count: number;
  current_user_chars: number;
  system_chars: number;
  last_message_chars: number;
  thinking_mode: string;
  tools_count: number;
  tool_names?: string[];
  provider_error_body?: string;
}) {
  console.info("kie_anthropic_request", input);
}

function createKieAnthropicClient(ctx: KieAdapterContext): Anthropic {
  return new Anthropic({
    authToken: ctx.apiKey,
    baseURL: buildKieAnthropicBaseUrl(ctx.baseUrl),
    timeout: AGENT_PROVIDER_TIMEOUT_MS,
  });
}

/** KIE Claude proxy via official Anthropic SDK. */
export class KieAnthropicProvider implements KieAdapter {
  async run(ctx: KieAdapterContext, input: AgentRequest): Promise<AgentProviderResponse> {
    const client = createKieAnthropicClient(ctx);
    const {
      params,
      messages,
      thinkingMode,
      toolsCount,
      systemChars,
      currentUserChars,
      lastMessageChars,
    } = buildAnthropicRequestParams(input, ctx);

    const endpoint = `${CLAUDE_ANTHROPIC_BASE_PATH}/v1/messages`;

    try {
      const response = await client.messages.create(params);

      logAnthropicRequestDiagnostics({
        model: ctx.model.providerModel,
        endpoint,
        http_status: 200,
        messages_count: messages.length,
        current_user_chars: currentUserChars,
        system_chars: systemChars,
        last_message_chars: lastMessageChars,
        thinking_mode: thinkingMode,
        tools_count: toolsCount,
        tool_names: params.tools?.map((tool) => tool.name),
      });

      const parsed = parseAnthropicResponse(response);
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
    } catch (error) {
      if (error instanceof APIError) {
        const text = typeof error.error === "object" ? JSON.stringify(error.error) : String(error.error ?? error.message);
        const providerError = normalizeKieError(error.status ?? 502, text, "application/json", "claude_sonnet");
        const parsed = parseKieErrorBody(text);

        logAnthropicRequestDiagnostics({
          model: ctx.model.providerModel,
          endpoint,
          http_status: error.status,
          messages_count: messages.length,
          current_user_chars: currentUserChars,
          system_chars: systemChars,
          last_message_chars: lastMessageChars,
          thinking_mode: thinkingMode,
          tools_count: toolsCount,
          tool_names: params.tools?.map((tool) => tool.name),
          provider_error_body: text ? text.slice(0, 4096) : undefined,
        });

        logKieProviderError({
          model_id: ctx.model.id,
          adapter: ctx.model.adapter,
          endpoint,
          http_status: error.status,
          content_type: "application/json",
          http_error_category: classifyKieHttpStatus(error.status ?? 500),
          normalized_error_code: providerError.code,
          response_parse_stage: "error_body",
          agent_run_id: ctx.agentRunId ?? undefined,
          response_body: text || undefined,
          ...parsed,
        });
        throw providerError;
      }
      throw error;
    }
  }
}

export const kieAnthropicProvider = new KieAnthropicProvider();
