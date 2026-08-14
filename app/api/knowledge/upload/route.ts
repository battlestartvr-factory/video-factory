import { getSessionUser } from "@/lib/auth/session";
import { apiSuccess, apiError, readJsonBody } from "@/lib/api/response";
import { generateRequestId, createLogger } from "@/lib/logging/logger";
import { knowledgeUploadSessionSchema } from "@/lib/validation/workspace-schemas";
import { isAllowedMime } from "@/lib/attachments/mime";
import { createKnowledgeUploadSession, uploadKnowledgeFileViaServer } from "@/lib/knowledge";
import {
  DriveStorageError,
  driveErrorHttpStatus,
  driveErrorUserMessage,
  getDriveAuthMode,
  isDriveStorageConfigured,
  normalizeDriveError,
} from "@/lib/storage/drive-provider";

export const maxDuration = 120;

const SERVER_UPLOAD_MAX_BYTES = 15 * 1024 * 1024;

function resolveUploadError(err: unknown): DriveStorageError {
  if (err instanceof DriveStorageError) return err;
  if (err instanceof Error) {
    if (err.message === "GOOGLE_DRIVE_NOT_CONFIGURED") {
      return new DriveStorageError(
        "DRIVE_NOT_CONFIGURED",
        driveErrorUserMessage("DRIVE_NOT_CONFIGURED"),
        { stage: "drive_config" },
      );
    }
    if (err.message === "GOOGLE_DRIVE_SHARED_FOLDER_ID_MISSING") {
      return new DriveStorageError(
        "DRIVE_NOT_CONFIGURED",
        driveErrorUserMessage("DRIVE_NOT_CONFIGURED"),
        { stage: "root_folder_config" },
      );
    }
  }
  return normalizeDriveError(err, "upload_session", "DRIVE_UPLOAD_SESSION_FAILED");
}

function resolveUploadCompletionError(err: unknown): {
  code: string;
  message: string;
  status: number;
} {
  if (err instanceof Error) {
    if (err.message === "DOCUMENT_NOT_FOUND") {
      return { code: "NOT_FOUND", message: "Документ не найден", status: 404 };
    }
    if (err.message === "DOCUMENT_NOT_UPLOADING") {
      return { code: "INVALID_STATE", message: "Документ уже обработан", status: 409 };
    }
    if (err.message === "UPLOAD_SESSION_MISSING") {
      return { code: "UPLOAD_SESSION_MISSING", message: "Сессия загрузки не найдена", status: 400 };
    }
    return { code: "DOCUMENT_EXTRACTION_FAILED", message: err.message, status: 500 };
  }
  return { code: "DOCUMENT_EXTRACTION_FAILED", message: "Не удалось обработать документ", status: 500 };
}

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const logger = createLogger({ request_id: requestId, event: "knowledge.upload" });
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  if (!isDriveStorageConfigured()) {
    return apiError(
      "DRIVE_NOT_CONFIGURED",
      "Google Drive не настроен для загрузки документов",
      503,
      requestId,
    );
  }

  const body = await readJsonBody<unknown>(request);
  const parsed = knowledgeUploadSessionSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);

  if (!isAllowedMime(parsed.data.mimeType)) {
    return apiError("INVALID_MIME", "Неподдерживаемый тип файла", 400, requestId);
  }

  try {
    const session = await createKnowledgeUploadSession({
      userId: user.id,
      filename: parsed.data.filename,
      mimeType: parsed.data.mimeType,
      sizeBytes: parsed.data.sizeBytes,
      projectId: parsed.data.projectId,
      tags: parsed.data.tags,
    });

    return apiSuccess(
      {
        documentId: session.document.id,
        status: session.document.status,
      },
      201,
    );
  } catch (err) {
    const normalized = resolveUploadError(err);
    logger.error("knowledge.upload.session_failed", {
      request_id: requestId,
      auth_mode: getDriveAuthMode(),
      stage: normalized.stage,
      normalized_drive_error: normalized.code,
      ...(normalized.googleHttpStatus !== undefined
        ? { google_http_status: normalized.googleHttpStatus }
        : {}),
      ...(normalized.googleErrorReason ? { google_error_reason: normalized.googleErrorReason } : {}),
    });

    return apiError(
      normalized.code,
      driveErrorUserMessage(normalized.code),
      driveErrorHttpStatus(normalized.code),
      requestId,
    );
  }
}

/** Server-side upload: browser sends file, server completes Drive resumable upload. */
export async function PATCH(request: Request) {
  const requestId = generateRequestId();
  const logger = createLogger({ request_id: requestId, event: "knowledge.upload" });
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  if (!isDriveStorageConfigured()) {
    return apiError(
      "DRIVE_NOT_CONFIGURED",
      "Google Drive не настроен для загрузки документов",
      503,
      requestId,
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return apiError("VALIDATION_ERROR", "Ожидается multipart/form-data", 400, requestId);
  }

  const documentId = formData.get("documentId");
  const file = formData.get("file");
  if (typeof documentId !== "string" || !documentId) {
    return apiError("VALIDATION_ERROR", "documentId обязателен", 400, requestId);
  }
  if (!(file instanceof File)) {
    return apiError("VALIDATION_ERROR", "file обязателен", 400, requestId);
  }

  if (file.size > SERVER_UPLOAD_MAX_BYTES) {
    return apiError(
      "FILE_TOO_LARGE",
      `Файл превышает лимит ${SERVER_UPLOAD_MAX_BYTES / (1024 * 1024)} МБ для серверной загрузки`,
      413,
      requestId,
    );
  }

  const mimeType = file.type || "application/octet-stream";
  if (!isAllowedMime(mimeType)) {
    return apiError("INVALID_MIME", "Неподдерживаемый тип файла", 400, requestId);
  }

  try {
    logger.info("knowledge.upload.server_started", {
      document_id: documentId,
      size_bytes: file.size,
      mime_type: mimeType,
    });

    const buffer = Buffer.from(await file.arrayBuffer());
    const doc = await uploadKnowledgeFileViaServer({
      userId: user.id,
      documentId,
      buffer,
    });

    return apiSuccess(doc);
  } catch (err) {
    const resolved = resolveUploadCompletionError(err);
    const normalized = err instanceof DriveStorageError ? err : resolveUploadError(err);
    logger.error("knowledge.upload.server_failed", {
      request_id: requestId,
      document_id: documentId,
      error: resolved.message,
      ...(normalized instanceof DriveStorageError ? { drive_error: normalized.code } : {}),
    });
    return apiError(resolved.code, resolved.message, resolved.status, requestId);
  }
}
