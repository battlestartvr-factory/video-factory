import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { apiSuccess, apiError, readJsonBody } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import { createMemorySchema, updateMemorySchema } from "@/lib/validation/workspace-schemas";
import type { MemoryItem } from "@/lib/types/workspace";

export async function GET(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const url = new URL(request.url);
  const scope = url.searchParams.get("scope");
  const projectId = url.searchParams.get("projectId");
  const search = url.searchParams.get("q");

  const service = createSupabaseServiceClient();
  let query = service
    .from("memory_items")
    .select("*")
    .eq("user_id", user.id)
    .order("pinned", { ascending: false })
    .order("importance", { ascending: false })
    .order("updated_at", { ascending: false });

  if (scope) query = query.eq("scope", scope);
  if (projectId) query = query.eq("project_id", projectId);
  if (search) query = query.ilike("content", `%${search}%`);

  const { data, error } = await query;
  if (error) return apiError("FETCH_FAILED", "Не удалось загрузить память", 500, requestId);

  return apiSuccess({ items: (data ?? []) as MemoryItem[] });
}

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const body = await readJsonBody<unknown>(request);
  const parsed = createMemorySchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);

  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("memory_items")
    .insert({
      user_id: user.id,
      scope: parsed.data.scope,
      project_id: parsed.data.scope === "project" ? parsed.data.projectId : null,
      content: parsed.data.content,
      category: parsed.data.category ?? null,
      source: parsed.data.source ?? "manual",
      importance: parsed.data.importance ?? 5,
      pinned: parsed.data.pinned ?? false,
    })
    .select()
    .single();

  if (error || !data) return apiError("CREATE_FAILED", "Не удалось создать запись", 500, requestId);
  return apiSuccess(data as MemoryItem, 201);
}

export async function PATCH(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return apiError("VALIDATION_ERROR", "id обязателен", 400, requestId);

  const body = await readJsonBody<unknown>(request);
  const parsed = updateMemorySchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);

  const service = createSupabaseServiceClient();
  const { data: existing } = await service
    .from("memory_items")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (!existing) return apiError("NOT_FOUND", "Запись не найдена", 404, requestId);

  const updates: Record<string, unknown> = {};
  if (parsed.data.content !== undefined) updates.content = parsed.data.content;
  if (parsed.data.category !== undefined) updates.category = parsed.data.category;
  if (parsed.data.importance !== undefined) updates.importance = parsed.data.importance;
  if (parsed.data.pinned !== undefined) updates.pinned = parsed.data.pinned;
  if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;

  const { data, error } = await service
    .from("memory_items")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error || !data) return apiError("UPDATE_FAILED", "Не удалось обновить запись", 500, requestId);
  return apiSuccess(data as MemoryItem);
}

export async function DELETE(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return apiError("VALIDATION_ERROR", "id обязателен", 400, requestId);

  const service = createSupabaseServiceClient();
  const { error } = await service.from("memory_items").delete().eq("id", id).eq("user_id", user.id);
  if (error) return apiError("DELETE_FAILED", "Не удалось удалить запись", 500, requestId);

  return apiSuccess({ deleted: true });
}
