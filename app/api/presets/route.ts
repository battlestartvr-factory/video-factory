import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { apiSuccess, apiError, readJsonBody } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import {
  createPresetSchema,
  updatePresetSchema,
} from "@/lib/validation/workspace-schemas";
import type { Preset } from "@/lib/types/workspace";

export async function GET(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const url = new URL(request.url);
  const type = url.searchParams.get("type");

  const service = createSupabaseServiceClient();
  let query = service
    .from("presets")
    .select("*")
    .or(`is_system.eq.true,user_id.eq.${user.id}`)
    .order("is_system", { ascending: false })
    .order("name");

  if (type) query = query.eq("type", type);

  const { data, error } = await query;
  if (error) return apiError("FETCH_FAILED", "Не удалось загрузить пресеты", 500, requestId);

  return apiSuccess({ presets: (data ?? []) as Preset[] });
}

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const body = await readJsonBody<unknown>(request);
  const parsed = createPresetSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);

  const service = createSupabaseServiceClient();

  if (parsed.data.isDefault) {
    await service
      .from("presets")
      .update({ is_default: false })
      .eq("user_id", user.id)
      .eq("type", parsed.data.type);
  }

  const { data, error } = await service
    .from("presets")
    .insert({
      user_id: user.id,
      type: parsed.data.type,
      name: parsed.data.name,
      settings: parsed.data.settings ?? {},
      is_default: parsed.data.isDefault ?? false,
    })
    .select()
    .single();

  if (error || !data) return apiError("CREATE_FAILED", "Не удалось создать пресет", 500, requestId);
  return apiSuccess(data as Preset, 201);
}

export async function PATCH(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const url = new URL(request.url);
  const presetId = url.searchParams.get("id");
  if (!presetId) return apiError("VALIDATION_ERROR", "id обязателен", 400, requestId);

  const body = await readJsonBody<unknown>(request);
  const parsed = updatePresetSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);

  const service = createSupabaseServiceClient();
  const { data: existing } = await service.from("presets").select("*").eq("id", presetId).single();
  if (!existing || (existing.user_id !== user.id && existing.is_system)) {
    return apiError("NOT_FOUND", "Пресет не найден", 404, requestId);
  }
  if (existing.is_system) {
    return apiError("FORBIDDEN", "Системные пресеты нельзя изменять", 403, requestId);
  }

  if (parsed.data.isDefault) {
    await service
      .from("presets")
      .update({ is_default: false })
      .eq("user_id", user.id)
      .eq("type", existing.type);
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.settings !== undefined) updates.settings = parsed.data.settings;
  if (parsed.data.isDefault !== undefined) updates.is_default = parsed.data.isDefault;

  const { data, error } = await service
    .from("presets")
    .update(updates)
    .eq("id", presetId)
    .select()
    .single();

  if (error || !data) return apiError("UPDATE_FAILED", "Не удалось обновить пресет", 500, requestId);
  return apiSuccess(data as Preset);
}

export async function DELETE(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const url = new URL(request.url);
  const presetId = url.searchParams.get("id");
  if (!presetId) return apiError("VALIDATION_ERROR", "id обязателен", 400, requestId);

  const service = createSupabaseServiceClient();
  const { data: existing } = await service.from("presets").select("*").eq("id", presetId).single();
  if (!existing || existing.user_id !== user.id) {
    return apiError("NOT_FOUND", "Пресет не найден", 404, requestId);
  }
  if (existing.is_system) {
    return apiError("FORBIDDEN", "Системные пресеты нельзя удалять", 403, requestId);
  }

  const { error } = await service.from("presets").delete().eq("id", presetId);
  if (error) return apiError("DELETE_FAILED", "Не удалось удалить пресет", 500, requestId);

  return apiSuccess({ deleted: true });
}
