import { AGENT_ERROR_CODES, CONTEXT_BUDGET } from "./config";
import { redactForStorage, truncateText } from "./redaction";
import { getToolByName } from "./tools";
import type { AgentToolCall, ToolContext, ToolResult } from "./types";

export interface ExecutedToolCall {
  call: AgentToolCall;
  result: ToolResult;
  normalized: Record<string, unknown>;
}

function normalizeToolResult(result: ToolResult): Record<string, unknown> {
  if (!result.ok) {
    return {
      ok: false,
      code: result.code ?? AGENT_ERROR_CODES.INTERNAL_ERROR,
      error: result.error ?? "Tool failed",
    };
  }
  const payload = {
    ok: true,
    data: result.data ?? null,
    sources: result.sources ?? undefined,
    generation: result.generation ?? undefined,
  };
  const json = JSON.stringify(payload);
  if (json.length <= CONTEXT_BUDGET.maxToolResultChars) return payload;
  return {
    ok: true,
    data: truncateText(json, CONTEXT_BUDGET.maxToolResultChars),
    truncated: true,
  };
}

export async function executeToolCall(
  call: AgentToolCall,
  ctx: ToolContext,
): Promise<ExecutedToolCall> {
  const tool = getToolByName(call.name);
  if (!tool) {
    const result: ToolResult = {
      ok: false,
      code: AGENT_ERROR_CODES.TOOL_NOT_FOUND,
      error: `Unknown tool: ${call.name}`,
    };
    return { call, result, normalized: normalizeToolResult(result) };
  }

  const parsed = tool.inputSchema.safeParse(call.arguments);
  if (!parsed.success) {
    const result: ToolResult = {
      ok: false,
      code: AGENT_ERROR_CODES.VALIDATION_ERROR,
      error: "Некорректные параметры инструмента",
    };
    return { call, result, normalized: normalizeToolResult(result) };
  }

  try {
    const result = await tool.handler(parsed.data, ctx);
    return { call, result, normalized: normalizeToolResult(result) };
  } catch {
    const result: ToolResult = {
      ok: false,
      code: AGENT_ERROR_CODES.INTERNAL_ERROR,
      error: "Инструмент завершился с ошибкой",
    };
    return { call, result, normalized: normalizeToolResult(result) };
  }
}

export async function executeToolCalls(
  calls: AgentToolCall[],
  ctx: ToolContext,
): Promise<ExecutedToolCall[]> {
  return Promise.all(calls.map((call) => executeToolCall(call, ctx)));
}

export function redactToolIO(value: unknown): Record<string, unknown> {
  return redactForStorage(value);
}
