import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { apiSuccess, apiError, readJsonBody } from "@/lib/api/response";
import { generateRequestId, createLogger } from "@/lib/logging/logger";
import { sendMessageSchema } from "@/lib/validation/workspace-schemas";
import { attachAssistantToRun, runUniversalAgent } from "@/lib/agent";
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

export async function POST(request: Request, { params }: Params) {
  const requestId = generateRequestId();
  const logger = createLogger({ request_id: requestId, event: "chat.message" });
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const { chatId } = await params;
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

  let agentResult;
  try {
    agentResult = await runUniversalAgent({
      requestId,
      userId: user.id,
      chat: typedChat,
      userMessage,
      modelId: parsed.data.modelId ?? typedChat.model_id,
      presetId: parsed.data.presetId ?? typedChat.preset_id,
      attachmentIds,
    });
  } catch (error) {
    logger.error("universal_agent_failed", {
      chat_id: chatId,
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
      chat_id: chatId,
      role: "assistant",
      content: agentResult.content,
      metadata: agentResult.metadata,
    })
    .select()
    .single();

  if (assistantError || !assistantMsg) {
    return apiError("CREATE_FAILED", "Не удалось создать ответ", 500, requestId);
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
      .eq("user_id", user.id);
  }

  await service.from("chats").update({ updated_at: new Date().toISOString() }).eq("id", chatId);

  return apiSuccess(
    {
      userMessage,
      assistantMessage: assistantMsg as ChatMessage,
      agentRun: {
        id: agentResult.agentRunId,
        status: agentResult.status,
        events: agentResult.events,
      },
    },
    201,
  );
}
