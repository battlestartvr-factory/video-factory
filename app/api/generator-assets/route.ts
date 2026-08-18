import { getSessionUser } from "@/lib/auth/session";
import { apiError, apiSuccess, readJsonBody } from "@/lib/api/response";
import { getMimeDefinition } from "@/lib/attachments/mime";
import { extractTextFromBuffer, isExtractableMime } from "@/lib/knowledge";
import { generateRequestId } from "@/lib/logging/logger";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BUCKET = "generator-inputs";
const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
const MAX_DOCUMENT_CONTEXT_CHARS = 12_000;

const VISUAL_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

function safeFilename(filename: string): string {
  const normalized = filename.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.replace(/^-+|-+$/g, "").slice(0, 120) || "asset";
}

function visualLimit(mimeType: string): number {
  return mimeType.startsWith("video/") ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
}

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

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

  const mimeType = file.type || "application/octet-stream";
  const definition = getMimeDefinition(mimeType);
  if (!definition) {
    return apiError("INVALID_MIME", "Этот тип файла не поддерживается генератором", 400, requestId);
  }

  if (definition.category === "document" || definition.category === "text") {
    if (!isExtractableMime(mimeType)) {
      return apiError("INVALID_DOCUMENT", "Документ нельзя использовать как текстовый контекст", 400, requestId);
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      return apiError("FILE_TOO_LARGE", "Документ превышает лимит 15 МБ", 413, requestId);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const extracted = await extractTextFromBuffer(buffer, mimeType, file.name);
    if (!extracted.text.trim()) {
      return apiError(
        extracted.needsOcr ? "DOCUMENT_NEEDS_OCR" : "DOCUMENT_EMPTY",
        extracted.needsOcr
          ? "В документе не найден извлекаемый текст. OCR для генератора пока не включён."
          : "В документе не найден текст для использования в промте.",
        400,
        requestId,
      );
    }

    return apiSuccess(
      {
        kind: "document",
        filename: file.name,
        mimeType,
        context: extracted.text.slice(0, MAX_DOCUMENT_CONTEXT_CHARS),
        truncated: extracted.text.length > MAX_DOCUMENT_CONTEXT_CHARS,
      },
      201,
    );
  }

  if (!VISUAL_MIMES.has(mimeType)) {
    return apiError(
      "INVALID_MIME",
      "Для визуальных референсов поддерживаются PNG, JPEG, WebP, MP4, MOV и WebM",
      400,
      requestId,
    );
  }
  if (file.size > visualLimit(mimeType)) {
    return apiError(
      "FILE_TOO_LARGE",
      mimeType.startsWith("video/") ? "Видео превышает лимит 100 МБ" : "Изображение превышает лимит 20 МБ",
      413,
      requestId,
    );
  }

  const service = createSupabaseServiceClient();
  const now = new Date();
  const datePrefix = now.toISOString().slice(0, 10);
  const storagePath = `${user.id}/${datePrefix}/${crypto.randomUUID()}-${safeFilename(file.name)}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await service.storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: mimeType,
    cacheControl: "3600",
    upsert: false,
  });
  if (uploadError) {
    return apiError("UPLOAD_FAILED", "Не удалось загрузить файл", 500, requestId);
  }

  const { data: signed, error: signedError } = await service.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (signedError || !signed?.signedUrl) {
    await service.storage.from(BUCKET).remove([storagePath]);
    return apiError("SIGNED_URL_FAILED", "Не удалось подготовить файл для генерации", 500, requestId);
  }

  return apiSuccess(
    {
      kind: "asset",
      asset: {
        id: crypto.randomUUID(),
        url: signed.signedUrl,
        storagePath,
        mimeType,
        filename: file.name,
        sizeBytes: file.size,
        category: definition.category,
      },
    },
    201,
  );
}

export async function DELETE(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const body = await readJsonBody<unknown>(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError("VALIDATION_ERROR", "storagePath обязателен", 400, requestId);
  }
  const storagePath = (body as Record<string, unknown>).storagePath;
  if (typeof storagePath !== "string" || !storagePath.startsWith(`${user.id}/`)) {
    return apiError("FORBIDDEN", "Файл недоступен", 403, requestId);
  }

  const service = createSupabaseServiceClient();
  const { error } = await service.storage.from(BUCKET).remove([storagePath]);
  if (error) return apiError("DELETE_FAILED", "Не удалось удалить файл", 500, requestId);
  return apiSuccess({ deleted: true });
}
