import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { apiSuccess, apiError, readJsonBody } from "@/lib/api/response";
import { generateRequestId, createLogger } from "@/lib/logging/logger";
import { sendMessageSchema } from "@/lib/validation/workspace-schemas";
import { attachAssistantToRun, runUniversalAgent } from "@/lib/agent";
import { encodeSseEvent, type StreamEvent } from "@/lib/agent/stream-events";
import type { Chat, ChatMessage } from "@/lib/types/workspace";

type Params = { params: Promise<{ chatId: string }> };

export async function GET(request: Request, { params }: Params) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const { chatId } = await params;
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
  const before = url.searchParams.get("before");

  const service = createSupabaseServiceClient();

  const { data: chat } = await service.from("chats").select("id").eq("id", chatId).eq("user_id", user.id).single();
  if (!chat) return apiError("NOT_FOUND", "Чат не найден", 404, requestId);

  let query = service
    .from("chat_messages")
    .select("*")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (before) query = query.lt("created_at", before);

  const { data, error } = await query;
  if (error) return apiError("FETCH_FAILED", "Не удалось загрузить сообщения", 500, requestId);

  const messages = ((data ?? []) as ChatMessage[]).reverse();
  return apiSuccess({ messages, hasMore: (data?.length ?? 0) === limit });
}

function generateAutoTitle(content: string): string {
  const cleaned = content.trim().replace(/\s+/g, " ");
  if (cleaned.length <= 50) return cleaned;
  return cleaned.slice(0, 47) + "…";
}

async function handleAgentTurn(input: {
  requestId: string;
  logger: ReturnType<typeof createLogger>;
  user: { id: string };
  chatId: string;
  chat: Chat;
  userMessage: ChatMessage;
  parsed: {
    content: string;
    modelId?: string;
    reasoningLevel?: string;
    presetId?: string;
    attachmentIds?: string[];
  };
  onStreamEvent?: (event: StreamEvent) => void;
}) {
  const service = createSupabaseServiceClient();

  let agentResult;
  try {
    agentResult = await runUniversalAgent({
      requestId: input.requestId,
      userId: input.user.id,
      chat: input.chat,
      userMessage: input.userMessage,
      modelId: input.parsed.modelId ?? input.chat.model_id,
      reasoningLevel: input.parsed.reasoningLevel,
      presetId: input.parsed.presetId ?? input.chat.preset_id,
      attachmentIds: input.parsed.attachmentIds,
      onStreamEvent: input.onStreamEvent,
    });
  } catch (error) {
    input.logger.error("universal_agent_failed", {
      chat_id: input.chatId,
      error_code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : "unknown",
    });
    agentResult = {
      content: "Не удалось обработать сообщение агентом.",
      metadata: {
        type: "error" as const,
        error: { code: "INTERNAL_ERROR", message: "Не удалось обработать сообщение", retryable: true },
      },
      agentRunId: "",
      events: [],
      status: "failed" as const,
    };
  }

  const { data: assistantMsg, error: assistantError } = await service
    .from("chat_messages")
    .insert({
      chat_id: input.chatId,
      role: "assistant",
      content: agentResult.content,
      metadata: agentResult.metadata,
    })
    .select()
    .single();

  if (assistantError || !assistantMsg) {
    throw new Error("CREATE_ASSISTANT_FAILED");
  }

  if (agentResult.agentRunId) {
    await attachAssistantToRun(agentResult.agentRunId, assistantMsg.id);
  }

  const generationIds = (agentResult.metadata.generations ?? [])
    .map((item) => item.generationId)
    .concat(agentResult.metadata.generation ? [agentResult.metadata.generation.generationId] : []);
  if (generationIds.length) {
    await service
      .from("generations")
      .update({ message_id: assistantMsg.id })
      .in("id", generationIds)
      .eq("user_id", input.user.id);
  }

  await service.from("chats").update({
    updated_at: new Date().toISOString(),
    ...(input.parsed.modelId ? { model_id: input.parsed.modelId } : {}),
    ...(input.parsed.reasoningLevel
      ? { metadata: { ...(input.chat.metadata ?? {}), reasoning_level: input.parsed.reasoningLevel } }
      : {}),
  }).eq("id", input.chatId);

  return {
    userMessage: input.userMessage,
    assistantMessage: assistantMsg as ChatMessage,
    agentRun: {
      id: agentResult.agentRunId,
      status: agentResult.status,
      events: agentResult.events,
    },
  };
}

export async function POST(request: Request, { params }: Params) {
  const requestId = generateRequestId();
  const logger = createLogger({ request_id: requestId, event: "chat.message" });
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const { chatId } = await params;
  const url = new URL(request.url);
  const stream = url.searchParams.get("stream") === "1";

  const body = await readJsonBody<unknown>(request);
  const parsed = sendMessageSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);

  const service = createSupabaseServiceClient();

  const { data: chat } = await service.from("chats").select("*").eq("id", chatId).eq("user_id", user.id).single();
  if (!chat) return apiError("NOT_FOUND", "Чат не найден", 404, requestId);

  const attachmentIds = parsed.data.attachmentIds ?? [];
  const { data: userMsg, error: userError } = await service
    .from("chat_messages")
    .insert({
      chat_id: chatId,
      role: "user",
      content: parsed.data.content,
      metadata: attachmentIds.length ? { attachments: attachmentIds } : {},
    })
    .select()
    .single();

  if (userError || !userMsg) {
    return apiError("CREATE_FAILED", "Не удалось отправить сообщение", 500, requestId);
  }

  if (attachmentIds.length) {
    await service
      .from("chat_attachments")
      .update({ message_id: userMsg.id })
      .in("id", attachmentIds)
      .eq("user_id", user.id)
      .eq("chat_id", chatId);
  }

  if (chat.title === "Новый чат") {
    await service
      .from("chats")
      .update({ title: generateAutoTitle(parsed.data.content) })
      .eq("id", chatId);
  }

  const typedChat = chat as Chat;
  const userMessage = userMsg as ChatMessage;

  if (!stream) {
    try {
      const result = await handleAgentTurn({
        requestId,
        logger,
        user,
        chatId,
        chat: typedChat,
        userMessage,
        parsed: { ...parsed.data, attachmentIds },
      });
      return apiSuccess(result, 201);
    } catch {
      return apiError("CREATE_FAILED", "Не удалось создать ответ", 500, requestId);
    }
  }

  const encoder = new TextEncoder();
  const responseStream = new ReadableStream({
    async start(controller) {
      const send = (event: StreamEvent) => {
        controller.enqueue(encoder.encode(encodeSseEvent(event)));
      };

      send({
        type: "message.accepted",
        at: new Date().toISOString(),
      });

      try {
        const result = await handleAgentTurn({
          requestId,
          logger,
          user,
          chatId,
          chat: typedChat,
          userMessage,
          parsed: { ...parsed.data, attachmentIds },
          onStreamEvent: send,
        });

        send({
          type: "turn.completed",
          at: new Date().toISOString(),
          content: JSON.stringify(result),
        });
      } catch {
        send({
          type: "agent.run.failed",
          at: new Date().toISOString(),
          errorCode: "CREATE_FAILED",
          label: "✕ Ошибка обращения к модели",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(responseStream, {
    status: 201,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
