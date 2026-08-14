import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { apiSuccess, apiError, readJsonBody } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import { createGenerationSchema } from "@/lib/validation/workspace-schemas";
import {
  createImageGeneration,
  createVideoGeneration,
  GenerationValidationError,
} from "@/lib/generation";
import type { Generation } from "@/lib/types/workspace";

export async function GET(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 50);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const service = createSupabaseServiceClient();
  let query = service
    .from("generations")
    .select("*", { count: "exact" })
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (type) query = query.eq("type", type);

  const { data, error, count } = await query;
  if (error) return apiError("FETCH_FAILED", "Не удалось загрузить генерации", 500, requestId);

  return apiSuccess({ generations: (data ?? []) as Generation[], total: count ?? 0 });
}

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const body = await readJsonBody<unknown>(request);
  const parsed = createGenerationSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);

  try {
    const common = {
      userId: user.id,
      projectId: parsed.data.projectId,
      chatId: parsed.data.chatId,
      prompt: parsed.data.prompt,
      model: parsed.data.modelId,
      presetId: parsed.data.presetId,
      mode: parsed.data.mode,
      settings: parsed.data.settings,
      referenceAssets: parsed.data.referenceAssets,
    };
    const result =
      parsed.data.type === "image"
        ? await createImageGeneration(common)
        : await createVideoGeneration(common);
    return apiSuccess(result.generation, 201);
  } catch (error) {
    if (error instanceof GenerationValidationError) {
      return apiError(error.code, error.message, 400, requestId);
    }
    return apiError("CREATE_FAILED", "Не удалось создать генерацию", 500, requestId);
  }
}
