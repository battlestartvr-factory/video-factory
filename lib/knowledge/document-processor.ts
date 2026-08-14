import "server-only";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createLogger } from "@/lib/logging/logger";
import { getDriveStorageProvider, isDriveStorageConfigured, resolveKnowledgeFolderSegments } from "@/lib/storage/drive-provider";
import {
  buildChunks,
  extractTextFromBuffer,
  isSyncExtractionSafe,
} from "./file-extractors";
import { normalizeExtractedText } from "./extraction";
import type { KnowledgeDocument } from "@/lib/types/workspace";

export async function processKnowledgeDocument(documentId: string): Promise<KnowledgeDocument> {
  const logger = createLogger({ event: "knowledge.extract", document_id: documentId });
  const service = createSupabaseServiceClient();
  const { data: doc, error } = await service
    .from("knowledge_documents")
    .select("*")
    .eq("id", documentId)
    .single();

  if (error || !doc) throw new Error("DOCUMENT_NOT_FOUND");

  const typedDoc = doc as KnowledgeDocument & {
    drive_file_id?: string | null;
    storage_provider?: string | null;
  };

  if (!typedDoc.drive_file_id) {
    await service
      .from("knowledge_documents")
      .update({ status: "failed", extraction_error: "NO_DRIVE_FILE" })
      .eq("id", documentId);
    throw new Error("NO_DRIVE_FILE");
  }

  if (!isSyncExtractionSafe(typedDoc.size_bytes)) {
    await service
      .from("knowledge_documents")
      .update({ status: "uploaded", extraction_error: "ASYNC_EXTRACTION_REQUIRED" })
      .eq("id", documentId);
    return typedDoc;
  }

  await service
    .from("knowledge_documents")
    .update({ status: "extracting", extraction_error: null })
    .eq("id", documentId);

  logger.info("knowledge.extract.started", { document_id: documentId });

  try {
    const drive = getDriveStorageProvider();
    const buffer = await drive.downloadFile(typedDoc.drive_file_id);
    const extraction = await extractTextFromBuffer(
      buffer,
      typedDoc.mime_type ?? "application/octet-stream",
      typedDoc.filename,
    );

    if (extraction.needsOcr) {
      await service
        .from("knowledge_documents")
        .update({
          status: "needs_ocr",
          extraction_error: extraction.error ?? "SCANNED_PDF",
          processed_at: new Date().toISOString(),
        })
        .eq("id", documentId);
      const { data: updated } = await service.from("knowledge_documents").select("*").eq("id", documentId).single();
      return (updated ?? typedDoc) as KnowledgeDocument;
    }

    if (extraction.error || !extraction.text.trim()) {
      await service
        .from("knowledge_documents")
        .update({
          status: "failed",
          extraction_error: extraction.error ?? "EMPTY_TEXT",
          processed_at: new Date().toISOString(),
        })
        .eq("id", documentId);
      const { data: updated } = await service.from("knowledge_documents").select("*").eq("id", documentId).single();
      return (updated ?? typedDoc) as KnowledgeDocument;
    }

    const extracted = normalizeExtractedText(extraction.text);
    const chunks = buildChunks(extracted);

    await service.from("knowledge_chunks").delete().eq("document_id", documentId);

    if (chunks.length) {
      await service.from("knowledge_chunks").insert(
        chunks.map((content, index) => ({
          document_id: documentId,
          chunk_index: index,
          content,
          metadata: { filename: typedDoc.filename },
        })),
      );
    }

    logger.info("knowledge.extract.completed", {
      document_id: documentId,
      chunk_count: chunks.length,
    });

    await service
      .from("knowledge_documents")
      .update({
        status: "ready",
        extracted_text: extracted,
        extraction_error: null,
        processed_at: new Date().toISOString(),
      })
      .eq("id", documentId);

    logger.info("knowledge.ready", { document_id: documentId });

    const { data: updated } = await service.from("knowledge_documents").select("*").eq("id", documentId).single();
    return (updated ?? typedDoc) as KnowledgeDocument;
  } catch (err) {
    const message = err instanceof Error ? err.message : "EXTRACTION_FAILED";
    logger.error("knowledge.extract.failed", { document_id: documentId, error: message });
    await service
      .from("knowledge_documents")
      .update({ status: "failed", extraction_error: message })
      .eq("id", documentId);
    throw err;
  }
}

export async function ensureKnowledgeDriveFolder(projectId?: string | null): Promise<string> {
  if (!isDriveStorageConfigured()) {
    throw new Error("GOOGLE_DRIVE_NOT_CONFIGURED");
  }
  const drive = getDriveStorageProvider();
  return drive.ensureFolderPath(resolveKnowledgeFolderSegments(projectId));
}
