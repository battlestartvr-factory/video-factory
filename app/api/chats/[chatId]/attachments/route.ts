import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { apiSuccess, apiError } from "@/lib/api/response";
import { generateRequestId, createLogger } from "@/lib/logging/logger";
import { isAllowedMime } from "@/lib/attachments/mime";
import {
  createKnowledgeUploadSession,
  isExtractableMime,
  uploadKnowledgeFileViaServer,
} from "@/lib/knowledge";

const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
type Params = { params: Promise<{ chatId: string }> };

/**
 * Chat research/document ingestion.
 * Raw source is archived through the existing Knowledge -> Google Drive pipeline;
 * chat_attachments stores only the lightweight pointer + extracted text needed by the agent turn.
 */
export async function POST(request: Request, { params }: Params) {
  const requestId = generateRequestId();
  const logger = createLogger({ request_id: requestId, event: "chat.attachment" });
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const { chatId } = await params;
  const service = createSupabaseServiceClient();
  const { data: chat } = await service
    .from("chats")
    .select("id, user_id, project_id")
    .eq("id", chatId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!chat) return apiError("NOT_FOUND", "Чат не найден", 404, requestId);

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return apiError("VALIDATION_ERROR", "Ожидается multipart/form-data", 400, requestId);
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return apiError("VALIDATION_ERROR", "file обязателен", 400, requestId);
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return apiError("FILE_TOO_LARGE", "Документ превышает лимит 15 МБ", 413, requestId);
  }

  const mimeType = file.type || "application/octet-stream";
  if (!isAllowedMime(mimeType) || !isExtractableMime(mimeType)) {
    return apiError(
      "INVALID_MIME",
      "Для импорта в память через чат сейчас поддерживаются извлекаемые документы: TXT/MD/PDF/DOCX",
      400,
      requestId,
    );
  }

  try {
    const session = await createKnowledgeUploadSession({
      userId: user.id,
      filename: file.name,
      mimeType,
      sizeBytes: file.size,
      projectId: chat.project_id,
      tags: ["chat-import", "source-evidence"],
    });

    const buffer = Buffer.from(await file.arrayBuffer());
    const doc = await uploadKnowledgeFileViaServer({
      userId: user.id,
      documentId: session.document.id,
      buffer,
    });

    const { data: attachment, error } = await service
      .from("chat_attachments")
      .insert({
        chat_id: chatId,
        user_id: user.id,
        filename: file.name,
        mime_type: mimeType,
        size_bytes: file.size,
        storage_path: doc.drive_file_id ?? doc.storage_path ?? null,
        url: doc.drive_web_url ?? null,
        metadata: {
          document_id: doc.id,
          knowledge_status: doc.status,
          drive_file_id: doc.drive_file_id,
          drive_web_url: doc.drive_web_url,
          checksum_sha256: doc.checksum_sha256,
          extracted_text: doc.extracted_text ?? "",
          source_role: "source_evidence",
        },
      })
      .select("*")
      .single();

    if (error || !attachment) throw new Error("CHAT_ATTACHMENT_CREATE_FAILED");

    logger.info("chat.attachment.ready", {
      chat_id: chatId,
      attachment_id: attachment.id,
      document_id: doc.id,
      size_bytes: file.size,
    });

    return apiSuccess({
      attachmentId: attachment.id,
      documentId: doc.id,
      filename: file.name,
      status: doc.status,
    }, 201);
  } catch (error) {
    logger.error("chat.attachment.failed", {
      chat_id: chatId,
      error: error instanceof Error ? error.message : "unknown",
    });
    return apiError(
      "UPLOAD_FAILED",
      error instanceof Error ? error.message : "Не удалось загрузить и разобрать документ",
      500,
      requestId,
    );
  }
}
