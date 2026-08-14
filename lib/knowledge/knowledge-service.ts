import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { CONTEXT_BUDGET } from "@/lib/agent/config";
import { createLogger } from "@/lib/logging/logger";
import { chunkText, normalizeExtractedText } from "./extraction";
import { assertProjectAccess } from "@/lib/projects/access";
import {
  getDriveStorageProvider,
  isDriveStorageConfigured,
  resolveKnowledgeFolderSegments,
} from "@/lib/storage/drive-provider";
import { processKnowledgeDocument } from "./document-processor";
import {
  combineRankScore,
  extractSearchTerms,
  normalizeSearchQuery,
  scoreChunkContent,
  scoreFilename,
} from "./retrieval";
import type { KnowledgeBase, KnowledgeDocument, SourceCitation } from "@/lib/types/workspace";

export type KnowledgeScope = "global" | "project" | "all";

export interface KnowledgeHit {
  documentId: string;
  filename: string;
  title: string;
  chunkId: string;
  chunkIndex: number;
  text: string;
  score: number;
  scope: KnowledgeScope;
  source: "knowledge";
}

function escapeIlike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

/** @deprecated use scoreChunkContent from retrieval.ts */
export function scoreChunk(content: string, query: string): number {
  return scoreChunkContent(content, query, extractSearchTerms(query));
}

async function resolveBaseIds(
  userId: string,
  scope: KnowledgeScope,
  projectId: string | null,
): Promise<string[]> {
  const ids: string[] = [];
  const includeGlobal = scope === "global" || scope === "all";
  const includeProject = (scope === "project" || scope === "all") && Boolean(projectId);

  if (includeGlobal) {
    const globalBase = await getOrCreateKnowledgeBase(userId, null);
    ids.push(globalBase.id);
  }
  if (includeProject && projectId) {
    const projectBase = await getOrCreateKnowledgeBase(userId, projectId);
    ids.push(projectBase.id);
  }
  return ids;
}

export async function getOrCreateKnowledgeBase(
  userId: string,
  projectId?: string | null,
): Promise<KnowledgeBase> {
  if (projectId) await assertProjectAccess(userId, projectId);
  const service = createSupabaseServiceClient();
  let query = service.from("knowledge_bases").select("*").eq("user_id", userId);
  query = projectId ? query.eq("project_id", projectId) : query.is("project_id", null);

  const { data: existing } = await query.limit(1).maybeSingle();
  if (existing) return existing as KnowledgeBase;

  const { data, error } = await service
    .from("knowledge_bases")
    .insert({
      user_id: userId,
      project_id: projectId ?? null,
      name: projectId ? "База проекта" : "Основная база",
    })
    .select()
    .single();
  if (error || !data) throw new Error("Failed to create knowledge base");
  return data as KnowledgeBase;
}

export async function listKnowledgeDocuments(input: {
  userId: string;
  scope?: KnowledgeScope;
  projectId?: string | null;
}): Promise<KnowledgeDocument[]> {
  const scope = input.scope ?? (input.projectId ? "all" : "global");
  const baseIds = await resolveBaseIds(input.userId, scope, input.projectId ?? null);
  if (!baseIds.length) return [];
  const service = createSupabaseServiceClient();
  const { data } = await service
    .from("knowledge_documents")
    .select("*")
    .in("knowledge_base_id", baseIds)
    .order("created_at", { ascending: false })
    .limit(100);
  return (data ?? []) as KnowledgeDocument[];
}

export async function createKnowledgeUploadSession(input: {
  userId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  projectId?: string | null;
  tags?: string[];
}): Promise<{ document: KnowledgeDocument }> {
  if (!isDriveStorageConfigured()) {
    throw new Error("GOOGLE_DRIVE_NOT_CONFIGURED");
  }

  const base = await getOrCreateKnowledgeBase(input.userId, input.projectId ?? null);
  const drive = getDriveStorageProvider();
  const folderId = await drive.ensureFolderPath(resolveKnowledgeFolderSegments(input.projectId));
  const session = await drive.createResumableUpload({
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    folderId,
  });

  const service = createSupabaseServiceClient();
  const { data: doc, error } = await service
    .from("knowledge_documents")
    .insert({
      knowledge_base_id: base.id,
      user_id: input.userId,
      filename: input.filename,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      status: "uploading",
      tags: input.tags ?? [],
      source: "upload",
      storage_provider: "google_drive",
      metadata: { upload_folder_id: folderId, upload_url: session.uploadUrl },
    })
    .select()
    .single();

  if (error || !doc) throw new Error("Failed to create knowledge document");

  return { document: doc as KnowledgeDocument };
}

export async function finalizeKnowledgeUpload(input: {
  userId: string;
  documentId: string;
  driveFileId: string;
}): Promise<KnowledgeDocument> {
  const logger = createLogger({
    event: "knowledge.upload",
    document_id: input.documentId,
    user_id: input.userId,
  });
  const service = createSupabaseServiceClient();
  const { data: doc } = await service
    .from("knowledge_documents")
    .select("*")
    .eq("id", input.documentId)
    .eq("user_id", input.userId)
    .single();

  if (!doc) throw new Error("DOCUMENT_NOT_FOUND");

  const drive = getDriveStorageProvider();
  const meta = await drive.finalizeUpload(input.driveFileId);

  await service
    .from("knowledge_documents")
    .update({
      status: "uploaded",
      drive_file_id: input.driveFileId,
      storage_path: input.driveFileId,
      drive_web_url: meta.webViewUrl,
      checksum_sha256: meta.checksumSha256,
      size_bytes: meta.sizeBytes ?? doc.size_bytes,
    })
    .eq("id", input.documentId);

  logger.info("knowledge.upload.completed", {
    document_id: input.documentId,
    drive_file_id: input.driveFileId,
    size_bytes: meta.sizeBytes ?? doc.size_bytes,
  });

  return processKnowledgeDocument(input.documentId);
}

export async function uploadKnowledgeFileViaServer(input: {
  userId: string;
  documentId: string;
  buffer: Buffer;
}): Promise<KnowledgeDocument> {
  const service = createSupabaseServiceClient();
  const { data: doc } = await service
    .from("knowledge_documents")
    .select("*")
    .eq("id", input.documentId)
    .eq("user_id", input.userId)
    .single();

  if (!doc) throw new Error("DOCUMENT_NOT_FOUND");
  if (doc.status !== "uploading") throw new Error("DOCUMENT_NOT_UPLOADING");

  const meta = (doc.metadata ?? {}) as Record<string, unknown>;
  let uploadUrl = typeof meta.upload_url === "string" ? meta.upload_url : null;
  const mimeType = doc.mime_type ?? "application/octet-stream";

  if (!uploadUrl) {
    const folderId = typeof meta.upload_folder_id === "string" ? meta.upload_folder_id : null;
    if (!folderId) throw new Error("UPLOAD_SESSION_MISSING");

    const drive = getDriveStorageProvider();
    const session = await drive.createResumableUpload({
      filename: doc.filename,
      mimeType,
      sizeBytes: input.buffer.length,
      folderId,
    });
    uploadUrl = session.uploadUrl;
    await service
      .from("knowledge_documents")
      .update({
        metadata: { ...meta, upload_url: uploadUrl },
      })
      .eq("id", input.documentId);
  }

  const drive = getDriveStorageProvider();
  const driveFileId = await drive.completeResumableUpload({
    uploadUrl,
    mimeType,
    buffer: input.buffer,
  });

  return finalizeKnowledgeUpload({
    userId: input.userId,
    documentId: input.documentId,
    driveFileId,
  });
}

export async function addKnowledgeDocument(input: {
  userId: string;
  filename: string;
  mimeType: string;
  content?: string;
  sizeBytes?: number;
  tags?: string[];
  projectId?: string | null;
  source?: string;
}): Promise<KnowledgeDocument> {
  const base = await getOrCreateKnowledgeBase(input.userId, input.projectId ?? null);
  const service = createSupabaseServiceClient();

  if (!input.content && isDriveStorageConfigured()) {
    throw new Error("BINARY_UPLOAD_REQUIRES_DRIVE_SESSION");
  }

  if (!input.content) {
    throw new Error("CONTENT_REQUIRED");
  }

  const { data: doc, error } = await service
    .from("knowledge_documents")
    .insert({
      knowledge_base_id: base.id,
      user_id: input.userId,
      filename: input.filename,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes ?? null,
      status: "processing",
      tags: input.tags ?? [],
      source: input.source ?? "upload",
    })
    .select()
    .single();
  if (error || !doc) throw new Error("Failed to create knowledge document");

  const extracted = normalizeExtractedText(input.content);
  const chunks = chunkText(extracted);

  await service
    .from("knowledge_documents")
    .update({
      status: "ready",
      extracted_text: extracted,
      processed_at: new Date().toISOString(),
    })
    .eq("id", doc.id);

  if (chunks.length) {
    await service.from("knowledge_chunks").insert(
      chunks.map((content, index) => ({
        document_id: doc.id,
        chunk_index: index,
        content,
        metadata: { filename: input.filename },
      })),
    );
  }

  const { data: updated } = await service
    .from("knowledge_documents")
    .select("*")
    .eq("id", doc.id)
    .single();
  return (updated ?? doc) as KnowledgeDocument;
}

export async function searchKnowledge(input: {
  userId: string;
  query: string;
  scope?: KnowledgeScope;
  projectId?: string | null;
  limit?: number;
}): Promise<{ hits: KnowledgeHit[]; sources: SourceCitation[] }> {
  const scope = input.scope ?? (input.projectId ? "all" : "global");
  const baseIds = await resolveBaseIds(input.userId, scope, input.projectId ?? null);
  if (!baseIds.length) return { hits: [], sources: [] };

  const query = normalizeSearchQuery(input.query);
  const terms = extractSearchTerms(query);
  const limit = input.limit ?? CONTEXT_BUDGET.knowledgeChunks;
  const service = createSupabaseServiceClient();

  const { data: rpcRows, error: rpcError } = await service.rpc("search_knowledge_chunks", {
    p_base_ids: baseIds,
    p_query: query,
    p_limit: Math.min(limit * 4, 80),
  });

  type SearchRow = {
    chunk_id?: string;
    id?: string;
    document_id: string;
    chunk_index: number;
    content: string;
    filename: string;
    knowledge_base_id?: string;
    fts_rank?: number;
    filename_score?: number;
    _content_score?: number;
  };

  let rows: SearchRow[] = (rpcRows as SearchRow[] | null) ?? [];

  if (rpcError || !rows?.length) {
    const { data: fallbackChunks } = await service
      .from("knowledge_chunks")
      .select(
        "id, document_id, chunk_index, content, knowledge_documents!inner(filename, knowledge_base_id, status)",
      )
      .in("knowledge_documents.knowledge_base_id", baseIds)
      .eq("knowledge_documents.status", "ready");

    rows = (fallbackChunks ?? [])
      .filter((row) => {
        const doc = Array.isArray(row.knowledge_documents)
          ? row.knowledge_documents[0]
          : row.knowledge_documents;
        const filename =
          doc && typeof doc === "object" && "filename" in doc
            ? String((doc as { filename: string }).filename)
            : "";
        const content = String(row.content);
        const contentScore = scoreChunkContent(content, query, terms);
        const fileScore = scoreFilename(filename, query, terms);
        return contentScore > 0 || fileScore > 0;
      })
      .map((row) => {
        const doc = Array.isArray(row.knowledge_documents)
          ? row.knowledge_documents[0]
          : row.knowledge_documents;
        const filename =
          doc && typeof doc === "object" && "filename" in doc
            ? String((doc as { filename: string }).filename)
            : "document";
        const content = String(row.content);
        return {
          chunk_id: row.id,
          document_id: row.document_id,
          chunk_index: row.chunk_index,
          content,
          filename,
          knowledge_base_id: (doc as { knowledge_base_id?: string })?.knowledge_base_id ?? "",
          fts_rank: 0,
          filename_score: scoreFilename(filename, query, terms),
          _content_score: scoreChunkContent(content, query, terms),
        };
      });
  }

  const scored = (rows ?? [])
    .map((row) => {
      const content = String(row.content ?? "");
      const filename = String(row.filename ?? "document");
      const contentScore =
        "_content_score" in row && typeof row._content_score === "number"
          ? row._content_score
          : scoreChunkContent(content, query, terms);
      const ftsRank = Number(row.fts_rank ?? 0);
      const filenameScore = Number(row.filename_score ?? scoreFilename(filename, query, terms));
      const score = combineRankScore({
        ftsRank,
        filenameScore,
        contentScore,
        isProjectScoped: scope === "project",
      });

      return {
        documentId: String(row.document_id),
        filename,
        title: filename,
        chunkId: String(row.chunk_id ?? row.id ?? ""),
        chunkIndex: Number(row.chunk_index),
        text: content,
        score,
        scope,
        source: "knowledge" as const,
      };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const sources: SourceCitation[] = scored.map((hit) => ({
    documentId: hit.documentId,
    filename: hit.filename,
    title: hit.title,
    chunkIndex: hit.chunkIndex,
    excerpt: hit.text.slice(0, 300),
    source: "knowledge",
  }));

  return { hits: scored, sources };
}

export async function getKnowledgeDocument(
  userId: string,
  documentId: string,
): Promise<KnowledgeDocument | null> {
  const service = createSupabaseServiceClient();
  const { data } = await service
    .from("knowledge_documents")
    .select("*")
    .eq("id", documentId)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as KnowledgeDocument | null) ?? null;
}

export async function deleteKnowledgeDocument(userId: string, documentId: string): Promise<void> {
  const logger = createLogger({
    event: "knowledge.document",
    document_id: documentId,
    user_id: userId,
  });
  const service = createSupabaseServiceClient();
  const { data: doc } = await service
    .from("knowledge_documents")
    .select("*")
    .eq("id", documentId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!doc) throw new Error("DOCUMENT_NOT_FOUND");

  const typedDoc = doc as KnowledgeDocument & {
    drive_file_id?: string | null;
    metadata?: Record<string, unknown>;
  };

  let driveDeleted = false;
  let driveAlreadyGone = false;

  if (typedDoc.drive_file_id && isDriveStorageConfigured()) {
    try {
      const drive = getDriveStorageProvider();
      await drive.deleteFile(typedDoc.drive_file_id);
      driveDeleted = true;
    } catch (driveError) {
      if (isDriveFileNotFoundError(driveError)) {
        driveAlreadyGone = true;
        logger.info("drive_file_already_deleted", {
          drive_file_id: typedDoc.drive_file_id,
        });
      } else {
        await service
          .from("knowledge_documents")
          .update({
            status: "failed",
            metadata: {
              ...(typedDoc.metadata ?? {}),
              delete_audit: {
                drive_delete_failed: true,
                drive_file_id: typedDoc.drive_file_id,
                error: driveError instanceof Error ? driveError.message : "unknown",
                attempted_at: new Date().toISOString(),
              },
            },
          })
          .eq("id", documentId);
        throw new Error("DRIVE_DELETE_FAILED");
      }
    }
  }

  const { error } = await service
    .from("knowledge_documents")
    .delete()
    .eq("id", documentId)
    .eq("user_id", userId);
  if (error) throw new Error("Failed to delete knowledge document");

  logger.info("deleted", {
    filename: typedDoc.filename,
    drive_file_id: typedDoc.drive_file_id ?? null,
    drive_deleted: driveDeleted,
    drive_already_gone: driveAlreadyGone,
  });
}

function isDriveFileNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { code?: number; response?: { status?: number } };
  return candidate.code === 404 || candidate.response?.status === 404;
}

export { escapeIlike };
