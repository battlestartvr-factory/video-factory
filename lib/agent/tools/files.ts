import type { AgentTool } from "@/lib/agent/types";
import { extractDocumentSchema, inspectAttachmentSchema } from "@/lib/agent/schemas";
import { AGENT_ERROR_CODES, CONTEXT_BUDGET } from "@/lib/agent/config";
import { chunkText, getKnowledgeDocument, isExtractableMime, normalizeExtractedText } from "@/lib/knowledge";
import { getCategoryFromMime } from "@/lib/attachments/mime";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { truncateText } from "@/lib/agent/redaction";
import type { ChatAttachment } from "@/lib/types/workspace";

async function loadAttachment(
  userId: string,
  attachmentId: string,
): Promise<ChatAttachment | null> {
  const service = createSupabaseServiceClient();
  const { data } = await service
    .from("chat_attachments")
    .select("*")
    .eq("id", attachmentId)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as ChatAttachment | null) ?? null;
}

export const inspectAttachmentTool: AgentTool<typeof inspectAttachmentSchema._output> = {
  name: "inspect_attachment",
  description:
    "Inspect a chat attachment: metadata, MIME category, and safe previews. Images return metadata (vision may already see them). Videos return metadata only — never raw video bytes. Documents return whether extractable text is available.",
  inputSchema: inspectAttachmentSchema,
  risk: "safe",
  async handler(input, ctx) {
    const attachment = await loadAttachment(ctx.userId, input.attachment_id);
    if (!attachment) {
      return { ok: false, code: AGENT_ERROR_CODES.NOT_FOUND, error: "Вложение не найдено" };
    }
    const category = getCategoryFromMime(attachment.mime_type);
    const meta = (attachment.metadata ?? {}) as Record<string, unknown>;
    const textPreview =
      typeof meta.extracted_text === "string"
        ? meta.extracted_text
        : typeof meta.text === "string"
          ? meta.text
          : undefined;

    return {
      ok: true,
      data: {
        id: attachment.id,
        filename: attachment.filename,
        mime_type: attachment.mime_type,
        size_bytes: attachment.size_bytes,
        category,
        extractable: isExtractableMime(attachment.mime_type),
        has_text: Boolean(textPreview),
        text_preview: textPreview
          ? truncateText(textPreview, CONTEXT_BUDGET.maxAttachmentTextChars)
          : undefined,
        image:
          category === "image"
            ? { available_for_vision: Boolean(attachment.url), width: meta.width, height: meta.height }
            : undefined,
        video:
          category === "video"
            ? {
                duration: meta.duration ?? meta.duration_sec,
                note: "Raw video is not sent to the LLM. Use metadata only.",
              }
            : undefined,
      },
    };
  },
};

export const extractDocumentTool: AgentTool<typeof extractDocumentSchema._output> = {
  name: "extract_document",
  description:
    "Extract text from a TXT/MD/PDF/DOCX attachment or knowledge document using the existing knowledge extraction pipeline. Does not create a second parser.",
  inputSchema: extractDocumentSchema,
  risk: "safe",
  async handler(input, ctx) {
    if (!input.attachment_id && !input.document_id) {
      return { ok: false, code: AGENT_ERROR_CODES.VALIDATION_ERROR, error: "Нужен attachment_id или document_id" };
    }

    if (input.document_id) {
      const doc = await getKnowledgeDocument(ctx.userId, input.document_id);
      if (!doc) {
        return { ok: false, code: AGENT_ERROR_CODES.NOT_FOUND, error: "Документ не найден" };
      }
      const text = doc.extracted_text ?? "";
      return {
        ok: true,
        data: {
          document_id: doc.id,
          title: doc.filename,
          status: doc.status,
          text: truncateText(text, CONTEXT_BUDGET.maxAttachmentTextChars),
          chunks: chunkText(text).slice(0, 8),
        },
      };
    }

    const attachment = await loadAttachment(ctx.userId, input.attachment_id!);
    if (!attachment) {
      return { ok: false, code: AGENT_ERROR_CODES.NOT_FOUND, error: "Вложение не найдено" };
    }
    if (!isExtractableMime(attachment.mime_type)) {
      return {
        ok: false,
        code: AGENT_ERROR_CODES.EXTRACT_UNAVAILABLE,
        error: "Этот тип файла нельзя извлечь как документ",
      };
    }
    const meta = (attachment.metadata ?? {}) as Record<string, unknown>;
    const raw =
      (typeof meta.extracted_text === "string" && meta.extracted_text) ||
      (typeof meta.text === "string" && meta.text) ||
      "";
    if (!raw) {
      return {
        ok: false,
        code: AGENT_ERROR_CODES.EXTRACT_UNAVAILABLE,
        error: "Текст ещё не извлечён из этого файла.",
      };
    }
    const text = normalizeExtractedText(raw);
    return {
      ok: true,
      data: {
        attachment_id: attachment.id,
        filename: attachment.filename,
        mime_type: attachment.mime_type,
        text: truncateText(text, CONTEXT_BUDGET.maxAttachmentTextChars),
        chunks: chunkText(text).slice(0, 8),
      },
    };
  },
};
