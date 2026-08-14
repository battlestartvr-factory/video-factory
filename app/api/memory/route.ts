import { getSessionUser } from "@/lib/auth/session";
import { apiSuccess, apiError, readJsonBody } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import { createMemorySchema, updateMemorySchema } from "@/lib/validation/workspace-schemas";
import { deleteMemory, listMemoryItems, saveMemory, updateMemory } from "@/lib/memory";
import type { MemoryScope } from "@/lib/types/workspace";

export async function GET(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const url = new URL(request.url);
  try {
    const items = await listMemoryItems({
      userId: user.id,
      scope: url.searchParams.get("scope"),
      projectId: url.searchParams.get("projectId"),
      search: url.searchParams.get("q"),
    });
    return apiSuccess({ items });
  } catch {
    return apiError("FETCH_FAILED", "Не удалось загрузить память", 500, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const body = await readJsonBody<unknown>(request);
  const parsed = createMemorySchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);

  try {
    const item = await saveMemory({
      userId: user.id,
      scope: parsed.data.scope as MemoryScope,
      projectId: parsed.data.scope === "project" ? parsed.data.projectId : null,
      content: parsed.data.content,
      category: parsed.data.category,
      source: parsed.data.source ?? "manual",
      importance: parsed.data.importance,
    });
    return apiSuccess(item, 201);
  } catch {
    return apiError("CREATE_FAILED", "Не удалось создать запись", 500, requestId);
  }
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

  try {
    const item = await updateMemory({
      userId: user.id,
      memoryId: id,
      content: parsed.data.content,
      category: parsed.data.category,
      importance: parsed.data.importance,
      pinned: parsed.data.pinned,
      enabled: parsed.data.enabled,
    });
    return apiSuccess(item);
  } catch (error) {
    if (error instanceof Error && error.name === "NotFoundError") {
      return apiError("NOT_FOUND", "Запись не найдена", 404, requestId);
    }
    return apiError("UPDATE_FAILED", "Не удалось обновить запись", 500, requestId);
  }
}

export async function DELETE(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return apiError("VALIDATION_ERROR", "id обязателен", 400, requestId);

  try {
    await deleteMemory(user.id, id);
    return apiSuccess({ deleted: true });
  } catch {
    return apiError("DELETE_FAILED", "Не удалось удалить запись", 500, requestId);
  }
}
