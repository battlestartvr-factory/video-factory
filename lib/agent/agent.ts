import "server-only";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createLogger } from "@/lib/logging/logger";
import {
  AGENT_ERROR_CODES,
} from "./config";
import { CONTEXT_LABELS, createAgentEvent } from "./events";
import { createAgentProvider, AgentProviderError, resolveAgentModel, resolveAgentReasoning } from "./provider";
import { getChatReasoningFromMetadata } from "@/lib/models/kie/registry";
import { loadAgentContext } from "./conversation";
import { assertCurrentUserMessage, AgentContextError } from "./context-builder";
import { runAgentToolLoop } from "./loop";
import { resolveToolsForTurn } from "./tools";
import { redactForStorage } from "./redaction";
import {
  streamEvent,
  toolCompletedSummary,
  type StreamEventEmitter,
} from "./stream-events";
import type { AgentEvent, AgentMessage, AgentProvider, ToolContext } from "./types";
import type {
  Chat,
  ChatMessage,
  GenerationCardData,
  MessageMetadata,
  SourceCitation,
  TaskCardData,
} from "@/lib/types/workspace";

export interface UniversalAgentInput {
  requestId: string;
  userId: string;
  chat: Chat;
  userMessage: ChatMessage;
  modelId?: string | null;
  reasoningLevel?: string | null;
  presetId?: string | null;
  attachmentIds?: string[];
  provider?: AgentProvider;
  onStreamEvent?: StreamEventEmitter;
}

export interface UniversalAgentResult {
  content: string;
  metadata: MessageMetadata;
  agentRunId: string;
  events: AgentEvent[];
  status: "completed" | "failed";
  errorCode?: string;
}

async function persistToolRun(input: {
  agentRunId: string;
  toolName: string;
  args: Record<string, unknown>;
  output: Record<string, unknown>;
  status: "completed" | "failed";
  errorCode?: string;
  errorMessage?: string;
  startedAt: string;
  durationMs: number;
}) {
  const service = createSupabaseServiceClient();
  await service.from("agent_tool_runs").insert({
    agent_run_id: input.agentRunId,
    tool_name: input.toolName,
    input: redactForStorage(input.args),
    output: redactForStorage(input.output),
    status: input.status,
    error_code: input.errorCode ?? null,
    error_message: input.errorMessage ?? null,
    started_at: input.startedAt,
    finished_at: new Date().toISOString(),
    duration_ms: input.durationMs,
  });
}

export async function runUniversalAgent(input: UniversalAgentInput): Promise<UniversalAgentResult> {
  const emit = input.onStreamEvent;
  const logger = createLogger({
    request_id: input.requestId,
    chat_id: input.chat.id,
    project_id: input.chat.project_id,
  });
  const service = createSupabaseServiceClient();
  const { model } = resolveAgentModel(input.modelId ?? input.chat.model_id);
  const reasoningFromInput = input.reasoningLevel;
  const reasoningFromChat = getChatReasoningFromMetadata(
    input.chat.metadata ?? {},
  );
  const reasoningLevel = reasoningFromInput ?? reasoningFromChat ?? "medium";
  const reasoningMeta = resolveAgentReasoning(model, reasoningLevel);
  const events: AgentEvent[] = [];
  const generations: GenerationCardData[] = [];
  const sources: SourceCitation[] = [];
  const tasks: TaskCardData[] = [];

  emit?.(streamEvent("message.accepted"));

  const { data: runRow, error: runError } = await service
    .from("agent_runs")
    .insert({
      request_id: input.requestId,
      user_id: input.userId,
      chat_id: input.chat.id,
      project_id: input.chat.project_id,
      user_message_id: input.userMessage.id,
      model,
      status: "running",
    })
    .select("id")
    .single();

  if (runError || !runRow) {
    logger.error("agent_run_create_failed", { error_code: "CREATE_FAILED" });
    emit?.(streamEvent("agent.run.failed", { errorCode: AGENT_ERROR_CODES.INTERNAL_ERROR }));
    return {
      content: "Не удалось запустить агента.",
      metadata: {
        type: "error",
        error: { code: AGENT_ERROR_CODES.INTERNAL_ERROR, message: "Не удалось запустить агента", retryable: true },
      },
      agentRunId: "",
      events,
      status: "failed",
      errorCode: AGENT_ERROR_CODES.INTERNAL_ERROR,
    };
  }

  const agentRunId = runRow.id as string;
  events.push(createAgentEvent("run_started", { status: "running" }));
  emit?.(streamEvent("agent.run.started", { agentRunId, label: CONTEXT_LABELS.thinking }));
  logger.info("agent_run_started", { agent_run_id: agentRunId, model });

  const fail = async (code: string, message: string): Promise<UniversalAgentResult> => {
    await service
      .from("agent_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_code: code,
        error_message: message,
      })
      .eq("id", agentRunId);
    events.push(createAgentEvent("error", { errorCode: code }));
    emit?.(streamEvent("agent.run.failed", { agentRunId, errorCode: code, label: "✕ Ошибка обращения к модели" }));
    return {
      content: message,
      metadata: {
        type: "error",
        error: { code, message, retryable: code === AGENT_ERROR_CODES.PROVIDER_NOT_CONFIGURED },
        agentRunId,
        events: events.map((event) => ({
          type: event.type,
          toolName: event.toolName,
          label: event.label,
          status: event.status,
        })),
      },
      agentRunId,
      events,
      status: "failed",
      errorCode: code,
    };
  };

  const provider = input.provider ?? createAgentProvider();
  let context;
  try {
    emit?.(streamEvent("context.started", { label: CONTEXT_LABELS.started }));
    events.push(createAgentEvent("context_started", { label: CONTEXT_LABELS.started }));
    context = await loadAgentContext({
      userId: input.userId,
      chat: input.chat,
      currentMessage: input.userMessage,
      modelId: model,
      presetId: input.presetId,
      attachmentIds: input.attachmentIds,
    });
    events.push(createAgentEvent("context_completed", { label: CONTEXT_LABELS.completed, status: "completed" }));
    emit?.(streamEvent("context.completed", { label: CONTEXT_LABELS.completed }));
  } catch {
    logger.error("context_build_failed", {
      agent_run_id: agentRunId,
      error_code: AGENT_ERROR_CODES.INTERNAL_ERROR,
    });
    return fail(AGENT_ERROR_CODES.INTERNAL_ERROR, "Не удалось собрать контекст");
  }

  logger.info("agent_context_built", {
    agent_run_id: agentRunId,
    runtime_policy_version: context.manifest.runtime_policy_version,
    agent_config_version: context.manifest.agent_config_version,
    personalization_present: context.manifest.personalization_present,
    global_memory_items: context.manifest.global_memory_items,
    project_id: context.manifest.project_id,
    project_memory_items: context.manifest.project_memory_items,
    retrieved_chunks_count: context.manifest.knowledge_chunks,
    messages_count: context.manifest.chat_messages,
    current_user_chars: context.manifest.current_user_message_chars,
    model_id: context.manifest.model,
  });

  const userMessageText =
    typeof input.userMessage.content === "string" ? input.userMessage.content : "";
  const { tools, toolNames, intent: turnIntent } = resolveToolsForTurn({
    userMessage: userMessageText,
    attachmentIds: input.attachmentIds,
    projectId: input.chat.project_id,
    presetId: input.presetId ?? input.chat.preset_id,
  });

  logger.info("agent_tools_resolved", {
    agent_run_id: agentRunId,
    turn_intent: turnIntent,
    tools_count: tools.length,
    tool_names: toolNames,
  });

  const toolCtx: ToolContext = {
    requestId: input.requestId,
    userId: input.userId,
    chatId: input.chat.id,
    projectId: input.chat.project_id,
    userMessageId: input.userMessage.id,
    agentRunId,
    userMessage: input.userMessage.content,
    attachments: [],
  };

  let loopResult;
  try {
    assertCurrentUserMessage(context.currentTurn);
    const providerMessages: AgentMessage[] = [...context.messages, context.currentTurn];
    loopResult = await runAgentToolLoop({
      provider,
      model,
      system: context.instructions,
      messages: providerMessages,
      tools,
      toolContext: toolCtx,
      reasoningLevel,
    });
  } catch (error) {
    if (error instanceof AgentContextError && error.code === AGENT_ERROR_CODES.CURRENT_USER_MESSAGE_MISSING) {
      return fail(error.code, "Текущее сообщение пользователя отсутствует");
    }
    if (error instanceof AgentProviderError) {
      return fail(error.code, providerNotConfiguredMessage(error.code));
    }
    logger.error("agent_loop_failed", {
      agent_run_id: agentRunId,
      error_code: AGENT_ERROR_CODES.INTERNAL_ERROR,
    });
    return fail(AGENT_ERROR_CODES.INTERNAL_ERROR, "Агент не смог завершить ответ");
  }

  for (const item of loopResult.executions) {
    const startedAt = new Date().toISOString();
    const toolLabel = createAgentEvent("tool_started", { toolName: item.call.name }).label;
    events.push(createAgentEvent("tool_started", { toolName: item.call.name }));
    emit?.(streamEvent("tool.started", { toolName: item.call.name, label: toolLabel, agentRunId }));

    const status = item.result.ok ? "completed" : "failed";
    await persistToolRun({
      agentRunId,
      toolName: item.call.name,
      args: item.call.arguments,
      output: item.normalized,
      status,
      errorCode: item.result.code,
      errorMessage: item.result.error,
      startedAt,
      durationMs: 0,
    });

    const summary = item.result.ok
      ? toolCompletedSummary(item.call.name, item.normalized as Record<string, unknown>)
      : `✕ ${item.result.error ?? "Ошибка инструмента"}`;

    events.push(
      createAgentEvent("tool_finished", {
        toolName: item.call.name,
        status,
        errorCode: item.result.code,
        label: summary,
      }),
    );

    if (status === "completed") {
      emit?.(
        streamEvent("tool.completed", {
          toolName: item.call.name,
          label: summary,
          summary,
          agentRunId,
        }),
      );
    } else {
      emit?.(
        streamEvent("tool.failed", {
          toolName: item.call.name,
          label: summary,
          errorCode: item.result.code,
          agentRunId,
        }),
      );
    }

    logger.info("tool_run", {
      agent_run_id: agentRunId,
      tool_name: item.call.name,
      status,
      error_code: item.result.code,
      generation_id: item.result.generation?.generationId,
      factory_job_id: item.result.task?.factoryJobId,
    });
    if (item.result.generation) {
      generations.push(item.result.generation);
      events.push(
        createAgentEvent("generation_created", {
          generationId: item.result.generation.generationId,
          toolName: item.call.name,
        }),
      );
      emit?.(
        streamEvent("generation.queued", {
          toolName: item.call.name,
          label: "Запускаю генерацию…",
          agentRunId,
        }),
      );
    }
    if (item.result.task) tasks.push(item.result.task);
    if (item.result.sources?.length) sources.push(...item.result.sources);
  }

  emit?.(streamEvent("agent.finalizing", { label: CONTEXT_LABELS.finalizing, agentRunId }));
  events.push(createAgentEvent("finalizing", { label: CONTEXT_LABELS.finalizing }));

  let finalContent = loopResult.content;
  if (!finalContent) {
    finalContent =
      generations.length || sources.length || tasks.length
        ? "Готово. Ниже — результаты выполнения."
        : loopResult.stopReason === "tool_limit"
          ? "Достигнут лимит шагов инструментов. Уточните задачу, и я продолжу."
          : "Готово.";
  }

  events.push(createAgentEvent("final", { status: "completed", label: "✓ Сформировал ответ" }));

  const metadata: MessageMetadata = {
    type: tasks.length ? "task" : generations.length ? "generation" : sources.length ? "sources" : "text",
    task: tasks[0],
    tasks: tasks.length ? tasks : undefined,
    generation: generations[0],
    generations: generations.length ? generations : undefined,
    sources: sources.length ? sources : undefined,
    agentRunId,
    events: events.map((event) => ({
      type: event.type,
      toolName: event.toolName,
      label: event.label,
      status: event.status,
    })),
  };

  await service
    .from("agent_runs")
    .update({
      status: "completed",
      finished_at: new Date().toISOString(),
      metadata: context.manifest,
      usage: {
        prompt_tokens: loopResult.usage.promptTokens ?? 0,
        completion_tokens: loopResult.usage.completionTokens ?? 0,
        total_tokens: loopResult.usage.totalTokens ?? 0,
        iterations: loopResult.executions.length,
        requested_reasoning: reasoningMeta?.requestedReasoning,
        effective_reasoning: reasoningMeta?.effectiveReasoning,
      },
    })
    .eq("id", agentRunId);

  logger.info("agent_run_completed", { agent_run_id: agentRunId, status: "completed" });

  emit?.(
    streamEvent("assistant.message", {
      content: finalContent,
      agentRunId,
    }),
  );

  return {
    content: finalContent,
    metadata,
    agentRunId,
    events,
    status: "completed",
  };
}

function providerNotConfiguredMessage(code: string): string {
  if (code === AGENT_ERROR_CODES.PROVIDER_NOT_CONFIGURED) {
    return "AI-провайдер не настроен. Добавьте KIE_API_KEY в .env.local и перезапустите приложение.";
  }
  if (code === AGENT_ERROR_CODES.MODEL_UNAVAILABLE) {
    return "Выбранная модель сейчас недоступна. Выберите другую модель.";
  }
  if (code === AGENT_ERROR_CODES.MODEL_CAPABILITY_MISSING || code === AGENT_ERROR_CODES.MODEL_CAPABILITY_MISMATCH) {
    return "Выбранная модель не поддерживает этот тип запроса.";
  }
  if (code === AGENT_ERROR_CODES.INVALID_REASONING_LEVEL) {
    return "Выбранный уровень рассуждения не поддерживается этой моделью.";
  }
  if (code === AGENT_ERROR_CODES.CLAUDE_REQUEST_INVALID) {
    return "Claude отклонил запрос как некорректный. Проверьте формат вложений или выберите другую модель.";
  }
  return "Ошибка AI-провайдера. Повторите запрос.";
}
