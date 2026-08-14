import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { apiSuccess, apiError, readJsonBody } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import { sendMessageSchema } from "@/lib/validation/workspace-schemas";
import type { ChatMessage, MessageMetadata } from "@/lib/types/workspace";

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

function detectAction(content: string): Record<string, unknown> | null {
  const lower = content.toLowerCase();
  if (lower.includes("сгенерируй видео") || lower.includes("generate video")) {
    return { action: "generate_video", prompt: content };
  }
  if (lower.includes("сгенерируй изображение") || lower.includes("generate image")) {
    return { action: "generate_image", prompt: content };
  }
  return null;
}

export async function POST(request: Request, { params }: Params) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const { chatId } = await params;
  const body = await readJsonBody<unknown>(request);
  const parsed = sendMessageSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);

  const service = createSupabaseServiceClient();

  const { data: chat } = await service.from("chats").select("*").eq("id", chatId).eq("user_id", user.id).single();
  if (!chat) return apiError("NOT_FOUND", "Чат не найден", 404, requestId);

  const { data: userMsg, error: userError } = await service
    .from("chat_messages")
    .insert({
      chat_id: chatId,
      role: "user",
      content: parsed.data.content,
      metadata: parsed.data.attachmentIds?.length
        ? { attachments: parsed.data.attachmentIds }
        : {},
    })
    .select()
    .single();

  if (userError || !userMsg) {
    return apiError("CREATE_FAILED", "Не удалось отправить сообщение", 500, requestId);
  }

  if (chat.title === "Новый чат") {
    await service
      .from("chats")
      .update({ title: generateAutoTitle(parsed.data.content) })
      .eq("id", chatId);
  }

  const detectedAction = detectAction(parsed.data.content);
  let assistantMetadata: MessageMetadata = { type: "text" };

  if (detectedAction) {
    assistantMetadata = {
      type: "task",
      task: {
        action: detectedAction.action as string,
        prompt: parsed.data.content,
        model: parsed.data.modelId ?? chat.model_id ?? undefined,
        status: "queued",
        progress: 0,
        settings: {},
      },
    };
  }

  const assistantContent = detectedAction
    ? "Задача создана и поставлена в очередь. Результат появится здесь после выполнения."
    : "Сообщение получено. Полная интеграция с AI-агентом будет подключена на следующем этапе.";

  const { data: assistantMsg, error: assistantError } = await service
    .from("chat_messages")
    .insert({
      chat_id: chatId,
      role: "assistant",
      content: assistantContent,
      metadata: assistantMetadata,
    })
    .select()
    .single();

  if (assistantError) {
    return apiError("CREATE_FAILED", "Не удалось создать ответ", 500, requestId);
  }

  await service.from("chats").update({ updated_at: new Date().toISOString() }).eq("id", chatId);

  return apiSuccess({
    userMessage: userMsg as ChatMessage,
    assistantMessage: assistantMsg as ChatMessage,
  }, 201);
}
