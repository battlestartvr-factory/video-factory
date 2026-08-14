import { AGENT_PROVIDER_TIMEOUT_MS } from "@/lib/agent/config";
import type { AgentRequest } from "@/lib/agent/types";
import type { KieAdapter, KieAdapterContext } from "./base";
import {
  buildReasoningBody,
  handleKieResponse,
  kieFetch,
  toClaudeMessages,
  toOpenAiMessages,
  toResponsesInput,
} from "./base";

export class KieOpenAIChatAdapter implements KieAdapter {
  async run(ctx: KieAdapterContext, input: AgentRequest) {
    const reasoningParams = buildReasoningBody(ctx);
    const response = await kieFetch(
      ctx,
      {
        model: ctx.model.providerModel,
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
        ...reasoningParams,
      },
      AGENT_PROVIDER_TIMEOUT_MS,
    );

    return handleKieResponse(ctx, response, (payload) => {
      const p = payload as {
        choices?: Array<{
          message?: { content?: string | null; tool_calls?: unknown };
          finish_reason?: string;
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };
      const choice = p.choices?.[0];
      return {
        content: choice?.message?.content ?? null,
        tool_calls: choice?.message?.tool_calls,
        finish_reason: choice?.finish_reason,
        usage: p.usage,
      };
    });
  }
}

export class KieResponsesAdapter implements KieAdapter {
  async run(ctx: KieAdapterContext, input: AgentRequest) {
    const reasoningParams = buildReasoningBody(ctx);
    const tools = input.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    const response = await kieFetch(
      ctx,
      {
        model: ctx.model.providerModel,
        input: toResponsesInput(input.system, input.messages),
        tools,
        ...(tools.length ? { tool_choice: "auto" } : {}),
        stream: false,
        ...reasoningParams,
      },
      AGENT_PROVIDER_TIMEOUT_MS,
    );

    return handleKieResponse(ctx, response, (payload) => {
      const p = payload as {
        output?: Array<{
          type?: string;
          content?: Array<{ type?: string; text?: string }>;
          name?: string;
          arguments?: string;
          call_id?: string;
        }>;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
        };
      };
      const outputs = p.output ?? [];
      const textParts = outputs
        .filter((o) => o.type === "message")
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text ?? "")
        .join("");
      const toolCalls = outputs
        .filter((o) => o.type === "function_call")
        .map((o) => ({
          id: o.call_id ?? crypto.randomUUID(),
          function: { name: o.name ?? "", arguments: o.arguments ?? "{}" },
        }));
      return {
        content: textParts || null,
        tool_calls: toolCalls,
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
        usage: {
          prompt_tokens: p.usage?.input_tokens,
          completion_tokens: p.usage?.output_tokens,
          total_tokens: p.usage?.total_tokens,
        },
      };
    });
  }
}

export class KieClaudeMessagesAdapter implements KieAdapter {
  async run(ctx: KieAdapterContext, input: AgentRequest) {
    const reasoningParams = buildReasoningBody(ctx);
    const messages = toClaudeMessages(input.messages);
    const tools = input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));

    const requestBody: Record<string, unknown> = {
      model: ctx.model.providerModel,
      system: input.system,
      messages,
      max_tokens: 8192,
      stream: false,
      ...reasoningParams,
      ...(tools.length ? { tools } : {}),
    };

    const response = await kieFetch(ctx, requestBody, AGENT_PROVIDER_TIMEOUT_MS);

    return handleKieResponse(
      ctx,
      response,
      (payload) => {
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
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      const toolCalls = (p.content ?? [])
        .filter((c) => c.type === "tool_use")
        .map((c) => ({
          id: c.id ?? crypto.randomUUID(),
          function: { name: c.name ?? "", arguments: JSON.stringify(c.input ?? {}) },
        }));
      return {
        content: text || null,
        tool_calls: toolCalls,
        finish_reason: p.stop_reason === "tool_use" || toolCalls.length ? "tool_calls" : "stop",
        usage: {
          prompt_tokens: p.usage?.input_tokens,
          completion_tokens: p.usage?.output_tokens,
          total_tokens: (p.usage?.input_tokens ?? 0) + (p.usage?.output_tokens ?? 0),
        },
      };
      },
      { requestBody },
    );
  }
}

/** Market task adapter — used for image/video generation dispatch (not LLM chat) */
export class KieMarketTaskAdapter {
  buildTaskPayload(
    ctx: KieAdapterContext,
    params: {
      prompt: string;
      mode: string;
      qualityParams?: Record<string, unknown>;
      settings?: Record<string, unknown>;
    },
  ): Record<string, unknown> {
    return {
      model: ctx.model.providerModel,
      prompt: params.prompt,
      mode: params.mode,
      ...params.qualityParams,
      ...params.settings,
    };
  }
}

/** Veo adapter — separate contract from generic market tasks */
export class KieVeoAdapter {
  buildGeneratePayload(
    ctx: KieAdapterContext,
    params: {
      prompt: string;
      mode: string;
      variant?: string;
      resolution?: string;
      settings?: Record<string, unknown>;
    },
  ): Record<string, unknown> {
    return {
      model: ctx.model.providerModel,
      prompt: params.prompt,
      mode: params.mode,
      variant: params.variant,
      resolution: params.resolution,
      ...params.settings,
    };
  }
}

export const kieOpenAIChatAdapter = new KieOpenAIChatAdapter();
export const kieResponsesAdapter = new KieResponsesAdapter();
export const kieClaudeMessagesAdapter = new KieClaudeMessagesAdapter();
export const kieMarketTaskAdapter = new KieMarketTaskAdapter();
export const kieVeoAdapter = new KieVeoAdapter();

export function getKieLlmAdapter(kind: KieAdapterContext["model"]["adapter"]): KieAdapter {
  switch (kind) {
    case "openai_chat":
      return kieOpenAIChatAdapter;
    case "responses":
      return kieResponsesAdapter;
    case "claude_messages":
      return kieClaudeMessagesAdapter;
    default:
      return kieOpenAIChatAdapter;
  }
}
