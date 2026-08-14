import { getSessionUser } from "@/lib/auth/session";
import { apiSuccess, apiError, readJsonBody } from "@/lib/api/response";
import { generateRequestId, createLogger } from "@/lib/logging/logger";
import { knowledgeUploadSessionSchema } from "@/lib/validation/workspace-schemas";
import { isAllowedMime } from "@/lib/attachments/mime";
import { createKnowledgeUploadSession, finalizeKnowledgeUpload } from "@/lib/knowledge";
import {
  DriveStorageError,
  driveErrorHttpStatus,
  driveErrorUserMessage,
  getDriveAuthMode,
  isDriveStorageConfigured,
  normalizeDriveError,
} from "@/lib/storage/drive-provider";

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
        uploadUrl: session.uploadUrl,
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

export async function PUT(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const body = await readJsonBody<{ documentId?: string; driveFileId?: string }>(request);
  if (!body.documentId || !body.driveFileId) {
    return apiError("VALIDATION_ERROR", "documentId и driveFileId обязательны", 400, requestId);
  }

  try {
    const doc = await finalizeKnowledgeUpload({
      userId: user.id,
      documentId: body.documentId,
      driveFileId: body.driveFileId,
    });
    return apiSuccess(doc);
  } catch (err) {
    const message =
      err instanceof Error && err.message ? err.message : "Не удалось обработать документ";
    return apiError("DOCUMENT_EXTRACTION_FAILED", message, 500, requestId);
  }
}
