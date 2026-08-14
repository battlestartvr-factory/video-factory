import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { apiSuccess, apiError } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import { loadContextSources } from "@/lib/agent/conversation";
import { buildAgentContext, buildContextPreview } from "@/lib/agent/context-builder";
import type { Chat, ChatMessage } from "@/lib/types/workspace";

type Params = { params: Promise<{ chatId: string }> };

async function getChatForUser(chatId: string, userId: string) {
  const service = createSupabaseServiceClient();
  const { data } = await service.from("chats").select("*").eq("id", chatId).single();
  if (!data || data.user_id !== userId) return null;
  return data as Chat;
}

export async function GET(request: Request, { params }: Params) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const { chatId } = await params;
  const chat = await getChatForUser(chatId, user.id);
  if (!chat) return apiError("NOT_FOUND", "Чат не найден", 404, requestId);

  const url = new URL(request.url);
  const draftContent = url.searchParams.get("content")?.trim();
  const modelId = url.searchParams.get("modelId") ?? chat.model_id ?? "gemini-3-6-flash";
  const presetId = url.searchParams.get("presetId") ?? chat.preset_id;

  let currentMessage: ChatMessage;
  if (draftContent) {
    currentMessage = {
      id: "preview-draft",
      chat_id: chatId,
      role: "user",
      content: draftContent,
      metadata: {},
      created_at: new Date().toISOString(),
    };
  } else {
    const service = createSupabaseServiceClient();
    const { data: lastUserMessage } = await service
      .from("chat_messages")
      .select("*")
      .eq("chat_id", chatId)
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!lastUserMessage) {
      currentMessage = {
        id: "preview-empty",
        chat_id: chatId,
        role: "user",
        content: "(нет сообщений — укажите ?content= для предпросмотра)",
        metadata: {},
        created_at: new Date().toISOString(),
      };
    } else {
      currentMessage = lastUserMessage as ChatMessage;
    }
  }

  const sources = await loadContextSources({
    userId: user.id,
    chat,
    currentMessage,
    modelId,
    presetId,
  });

  const context = buildAgentContext(sources);
  const layers = buildContextPreview(context);

  return apiSuccess({
    manifest: context.manifest,
    layers,
    instructionsCharCount: context.instructions.length,
    recentMessagesCount: context.messages.length,
    currentUserMessageChars: context.manifest.current_user_message_chars,
  });
}
