import { getSessionUser } from "@/lib/auth/session";
import { apiSuccess, apiError, readJsonBody } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import { knowledgeUploadSchema, knowledgeQuerySchema } from "@/lib/validation/workspace-schemas";
import { isAllowedMime } from "@/lib/attachments/mime";
import {
  addKnowledgeDocument,
  deleteKnowledgeDocument,
  getKnowledgeDocument,
  getOrCreateKnowledgeBase,
  listKnowledgeDocuments,
  searchKnowledge,
} from "@/lib/knowledge";
import { isDriveStorageConfigured } from "@/lib/storage/drive-provider";

export async function GET() {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  try {
    const knowledgeBase = await getOrCreateKnowledgeBase(user.id, null);
    const documents = await listKnowledgeDocuments({ userId: user.id, scope: "global" });
    return apiSuccess({ knowledgeBase, documents });
  } catch {
    return apiError("FETCH_FAILED", "Не удалось загрузить документы", 500, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const body = await readJsonBody<unknown>(request);
  const parsed = knowledgeUploadSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);

  if (!isAllowedMime(parsed.data.mimeType)) {
    return apiError("INVALID_MIME", "Неподдерживаемый тип файла", 400, requestId);
  }

  try {
    const doc = await addKnowledgeDocument({
      userId: user.id,
      filename: parsed.data.filename,
      mimeType: parsed.data.mimeType,
      content: parsed.data.content,
      sizeBytes: parsed.data.sizeBytes,
      tags: parsed.data.tags,
      source: "upload",
    });
    return apiSuccess(doc, 201);
  } catch {
    return apiError("CREATE_FAILED", "Не удалось загрузить документ", 500, requestId);
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
    const document = await getKnowledgeDocument(user.id, id);
    if (!document) return apiError("NOT_FOUND", "Документ не найден", 404, requestId);

    // A Drive-backed record is deliberately kept if Drive cleanup cannot run.
    // This prevents losing the only pointer to an orphaned remote file.
    if (document.drive_file_id && !isDriveStorageConfigured()) {
      return apiError(
        "GOOGLE_DRIVE_NOT_CONFIGURED",
        "Google Drive недоступен: документ не удалён, чтобы не оставить файл-сироту",
        503,
        requestId,
      );
    }

    await deleteKnowledgeDocument(user.id, id);
    return apiSuccess({ deleted: true });
  } catch {
    return apiError("DELETE_FAILED", "Не удалось удалить документ из базы знаний и Google Drive", 500, requestId);
  }
}

export async function PUT(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const body = await readJsonBody<unknown>(request);
  const parsed = knowledgeQuerySchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);

  try {
    const { hits, sources } = await searchKnowledge({
      userId: user.id,
      query: parsed.data.query,
      scope: "global",
    });
    return apiSuccess({
      answer: hits.length
        ? `Найдено ${hits.length} релевантных фрагментов.`
        : "По вашему запросу ничего не найдено в базе знаний.",
      sources,
    });
  } catch {
    return apiError("FETCH_FAILED", "Не удалось выполнить поиск", 500, requestId);
  }
}
