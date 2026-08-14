import { getSessionUser, canEditProject } from "@/lib/auth/session";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { apiSuccess, apiError, readJsonBody } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import { updateProjectSchema } from "@/lib/validation/workspace-schemas";
import type { Project } from "@/lib/types/database";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const { projectId } = await params;
  const service = createSupabaseServiceClient();
  const { data, error } = await service.from("projects").select("*").eq("id", projectId).single();

  if (error || !data) return apiError("NOT_FOUND", "Проект не найден", 404, requestId);
  return apiSuccess(data as Project);
}

export async function PATCH(request: Request, { params }: Params) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const { projectId } = await params;
  const canEdit = await canEditProject(user.id, projectId);
  if (!canEdit) return apiError("FORBIDDEN", "Нет прав на редактирование", 403, requestId);

  const body = await readJsonBody<unknown>(request);
  const parsed = updateProjectSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;
  if (parsed.data.systemPrompt !== undefined) updates.system_prompt = parsed.data.systemPrompt;

  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("projects")
    .update(updates)
    .eq("id", projectId)
    .select()
    .single();

  if (error || !data) return apiError("UPDATE_FAILED", "Не удалось обновить проект", 500, requestId);
  return apiSuccess(data as Project);
}
