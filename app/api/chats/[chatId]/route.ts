import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { apiSuccess, apiError, readJsonBody } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import { updateChatSchema } from "@/lib/validation/workspace-schemas";
import type { Chat } from "@/lib/types/workspace";

type Params = { params: Promise<{ chatId: string }> };

async function getChatForUser(chatId: string, userId: string) {
  const service = createSupabaseServiceClient();
  const { data } = await service.from("chats").select("*").eq("id", chatId).single();
  if (!data || data.user_id !== userId) return null;
  return data as Chat;
}

export async function GET(_request: Request, { params }: Params) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const { chatId } = await params;
  const chat = await getChatForUser(chatId, user.id);
  if (!chat) return apiError("NOT_FOUND", "Чат не найден", 404, requestId);

  return apiSuccess(chat);
}

export async function PATCH(request: Request, { params }: Params) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const { chatId } = await params;
  const chat = await getChatForUser(chatId, user.id);
  if (!chat) return apiError("NOT_FOUND", "Чат не найден", 404, requestId);

  const body = await readJsonBody<unknown>(request);
  const parsed = updateChatSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);

  const updates: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) updates.title = parsed.data.title;
  if (parsed.data.modelId !== undefined) updates.model_id = parsed.data.modelId;
  if (parsed.data.presetId !== undefined) updates.preset_id = parsed.data.presetId;
  if (parsed.data.summary !== undefined) updates.summary = parsed.data.summary;
  if (parsed.data.archived !== undefined) {
    updates.archived_at = parsed.data.archived ? new Date().toISOString() : null;
  }

  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("chats")
    .update(updates)
    .eq("id", chatId)
    .select()
    .single();

  if (error || !data) return apiError("UPDATE_FAILED", "Не удалось обновить чат", 500, requestId);
  return apiSuccess(data as Chat);
}

export async function DELETE(_request: Request, { params }: Params) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const { chatId } = await params;
  const chat = await getChatForUser(chatId, user.id);
  if (!chat) return apiError("NOT_FOUND", "Чат не найден", 404, requestId);

  const service = createSupabaseServiceClient();
  const { error } = await service.from("chats").delete().eq("id", chatId);
  if (error) return apiError("DELETE_FAILED", "Не удалось удалить чат", 500, requestId);

  return apiSuccess({ deleted: true });
}
