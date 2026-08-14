import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { apiSuccess, apiError, readJsonBody } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import { updatePreferencesSchema } from "@/lib/validation/workspace-schemas";
import type { UserPreferences } from "@/lib/types/workspace";

const DEFAULT_PREFERENCES = {
  personalization: {},
  appearance: { theme: "dark", accentColor: "amber", font: "geist", density: "comfortable" },
};

export async function GET() {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const service = createSupabaseServiceClient();
  const { data } = await service
    .from("user_preferences")
    .select("*")
    .eq("user_id", user.id)
    .single();

  if (!data) {
    return apiSuccess({
      user_id: user.id,
      ...DEFAULT_PREFERENCES,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as UserPreferences);
  }

  return apiSuccess(data as UserPreferences);
}

export async function PATCH(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const body = await readJsonBody<unknown>(request);
  const parsed = updatePreferencesSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);

  const service = createSupabaseServiceClient();
  const { data: existing } = await service
    .from("user_preferences")
    .select("*")
    .eq("user_id", user.id)
    .single();

  const merged = {
    personalization: {
      ...(existing?.personalization as Record<string, unknown> ?? {}),
      ...(parsed.data.personalization ?? {}),
    },
    appearance: {
      ...(existing?.appearance as Record<string, unknown> ?? DEFAULT_PREFERENCES.appearance),
      ...(parsed.data.appearance ?? {}),
    },
  };

  const { data, error } = await service
    .from("user_preferences")
    .upsert({
      user_id: user.id,
      personalization: merged.personalization,
      appearance: merged.appearance,
    })
    .select()
    .single();

  if (error || !data) return apiError("UPDATE_FAILED", "Не удалось сохранить настройки", 500, requestId);
  return apiSuccess(data as UserPreferences);
}
