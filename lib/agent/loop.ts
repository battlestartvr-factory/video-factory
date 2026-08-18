import {
  AGENT_ERROR_CODES,
  AGENT_MAX_REPEATED_TOOL_FAILURES,
  AGENT_MAX_TOOL_ITERATIONS,
} from "./config";
import { executeToolCalls, type ExecutedToolCall } from "./tool-runner";
import type {
  AgentMessage,
  AgentProvider,
  AgentToolCall,
  AgentToolDefinition,
  AgentUsage,
  ToolContext,
} from "./types";

export interface AgentLoopInput {
  provider: AgentProvider;
  model: string;
  system: string;
  messages: AgentMessage[];
  tools: AgentToolDefinition[];
  toolContext: ToolContext;
  maxIterations?: number;
  reasoningLevel?: string | null;
}

export interface AgentLoopOutput {
  content: string;
  messages: AgentMessage[];
  executions: ExecutedToolCall[];
  usage: AgentUsage;
  stopReason: "final" | "tool_limit" | "repeated_failure";
}

/**
 * Explicit Stage 4 discovery admission is deterministic. Once intent routing has narrowed
 * the turn to the single durable discovery tool, asking an LLM to decide whether to call
 * that same tool adds cost and creates a provider failure point without adding judgment.
 */
async function runDeterministicDiscoveryAdmission(
  input: AgentLoopInput,
): Promise<AgentLoopOutput | null> {
  if (input.tools.length !== 1 || input.tools[0]?.name !== "start_game_discovery") return null;

  const call: AgentToolCall = {
    id: `deterministic-discovery-${input.toolContext.userMessageId}`,
    name: "start_game_discovery",
    arguments: {},
  };
  const executed = await executeToolCalls([call], input.toolContext);
  const result = executed[0]?.result;
  const content = result?.ok
    ? result.userContent ?? "Запустил Stage 4 discovery batch."
    : result?.error ?? "Не удалось запустить Stage 4 discovery batch.";

  return {
    content,
    messages: [...input.messages],
    executions: executed,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    stopReason: "final",
  };
}

export async function runAgentToolLoop(input: AgentLoopInput): Promise<AgentLoopOutput> {
  const deterministicDiscovery = await runDeterministicDiscoveryAdmission(input);
  if (deterministicDiscovery) return deterministicDiscovery;

  const messages = [...input.messages];
  const executions: ExecutedToolCall[] = [];
  const usage: AgentUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const failCounts = new Map<string, number>();
  const maxIterations = input.maxIterations ?? AGENT_MAX_TOOL_ITERATIONS;
  let content = "";
  let stopReason: AgentLoopOutput["stopReason"] = "final";

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const response = await input.provider.run({
      model: input.model,
      system: input.system,
      messages,
      tools: input.tools,
      reasoningLevel: input.reasoningLevel,
    });
    usage.promptTokens = (usage.promptTokens ?? 0) + (response.usage?.promptTokens ?? 0);
    usage.completionTokens = (usage.completionTokens ?? 0) + (response.usage?.completionTokens ?? 0);
    usage.totalTokens = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);

    if (!response.toolCalls.length) {
      content = response.content?.trim() || content;
      stopReason = "final";
      break;
    }

    messages.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
    });

    const executed = await executeToolCalls(response.toolCalls, input.toolContext);
    executions.push(...executed);

    let terminateContent: string | null = null;
    for (const item of executed) {
      if (!item.result.ok) {
        failCounts.set(item.call.name, (failCounts.get(item.call.name) ?? 0) + 1);
      } else {
        failCounts.set(item.call.name, 0);
      }
      if (item.result.terminate && item.result.userContent) {
        terminateContent = item.result.userContent;
      }
      messages.push({
        role: "tool",
        toolCallId: item.call.id,
        name: item.call.name,
        content: JSON.stringify(item.normalized),
      });
    }

    if (terminateContent) {
      content = terminateContent;
      stopReason = "final";
      break;
    }

    const repeated = [...failCounts.entries()].find(
      ([, count]) => count >= AGENT_MAX_REPEATED_TOOL_FAILURES,
    );
    if (repeated) {
      messages.push({
        role: "user",
        content: `Tool ${repeated[0]} failed repeatedly. Stop retrying it and answer the user with what you have.`,
      });
      stopReason = "repeated_failure";
    }

    if (iteration === maxIterations - 1) {
      stopReason = "tool_limit";
      content =
        content ||
        "Достигнут лимит шагов инструментов. Уточните задачу, и я продолжу.";
    }
  }

  if (!content && stopReason === "tool_limit") {
    content = `Достигнут лимит инструментов (${maxIterations}). ${AGENT_ERROR_CODES.TOOL_LIMIT_REACHED}`;
  }

  return { content, messages, executions, usage, stopReason };
}
