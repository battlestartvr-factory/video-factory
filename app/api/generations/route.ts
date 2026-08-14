import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { apiSuccess, apiError, readJsonBody } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import { createGenerationSchema } from "@/lib/validation/workspace-schemas";
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

  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("generations")
    .insert({
      user_id: user.id,
      type: parsed.data.type,
      mode: parsed.data.mode,
      prompt: parsed.data.prompt,
      model_id: parsed.data.modelId,
      preset_id: parsed.data.presetId ?? null,
      settings: parsed.data.settings ?? {},
      reference_assets: parsed.data.referenceAssets ?? [],
      project_id: parsed.data.projectId ?? null,
      chat_id: parsed.data.chatId ?? null,
      status: "queued",
    })
    .select()
    .single();

  if (error || !data) return apiError("CREATE_FAILED", "Не удалось создать генерацию", 500, requestId);

  // Future: dispatch to n8n/factory pipeline. For now, mark as pending.
  return apiSuccess(data as Generation, 201);
}
