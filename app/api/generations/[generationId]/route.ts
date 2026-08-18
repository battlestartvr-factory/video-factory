import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { apiError, apiSuccess } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import type { Generation } from "@/lib/types/workspace";

export async function GET(
  _request: Request,
  context: { params: Promise<{ generationId: string }> },
) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const { generationId } = await context.params;
  if (!generationId) return apiError("NOT_FOUND", "Генерация не найдена", 404, requestId);

  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("generations")
    .select("*")
    .eq("id", generationId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) return apiError("FETCH_FAILED", "Не удалось загрузить генерацию", 500, requestId);
  if (!data) return apiError("NOT_FOUND", "Генерация не найдена", 404, requestId);

  return apiSuccess(data as Generation);
}
