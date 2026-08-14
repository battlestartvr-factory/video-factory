import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { apiSuccess, apiError, readJsonBody } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import { createChatSchema } from "@/lib/validation/workspace-schemas";
import type { Chat } from "@/lib/types/workspace";

export async function GET(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 50);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const includeArchived = url.searchParams.get("archived") === "true";

  const service = createSupabaseServiceClient();
  let query = service
    .from("chats")
    .select("*", { count: "exact" })
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (projectId) query = query.eq("project_id", projectId);
  if (!includeArchived) query = query.is("archived_at", null);

  const { data, error, count } = await query;
  if (error) return apiError("FETCH_FAILED", "Не удалось загрузить чаты", 500, requestId);

  return apiSuccess({ chats: (data ?? []) as Chat[], total: count ?? 0 });
}

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const body = await readJsonBody<unknown>(request);
  const parsed = createChatSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);

  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("chats")
    .insert({
      user_id: user.id,
      project_id: parsed.data.projectId ?? null,
      title: parsed.data.title ?? "Новый чат",
      model_id: parsed.data.modelId ?? "gemini-3-6-flash",
      preset_id: parsed.data.presetId ?? "00000000-0000-4000-8000-000000000001",
    })
    .select()
    .single();

  if (error || !data) return apiError("CREATE_FAILED", "Не удалось создать чат", 500, requestId);
  return apiSuccess(data as Chat, 201);
}
