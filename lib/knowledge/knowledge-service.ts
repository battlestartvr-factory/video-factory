import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { CONTEXT_BUDGET } from "@/lib/agent/config";
import { chunkText, normalizeExtractedText } from "./extraction";
import { assertProjectAccess } from "@/lib/projects/access";
import type { KnowledgeBase, KnowledgeDocument, SourceCitation } from "@/lib/types/workspace";

export type KnowledgeScope = "global" | "project" | "all";

export interface KnowledgeHit {
  document_id: string;
  title: string;
  chunk: string;
  score: number;
  source: "knowledge";
  chunk_index: number;
}

function escapeIlike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

function scoreChunk(content: string, query: string): number {
  const hay = content.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1);
  if (!terms.length) return hay.includes(query.toLowerCase()) ? 1 : 0;
  let hits = 0;
  for (const term of terms) {
    if (hay.includes(term)) hits += 1;
  }
  return hits / terms.length;
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

  const textContent =
    input.content ?? `[Содержимое ${input.filename} будет извлечено при обработке]`;
  const extracted = normalizeExtractedText(textContent);
  const chunks = chunkText(extracted);

  await service
    .from("knowledge_documents")
    .update({
      status: "ready",
      extracted_text: extracted,
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

  const service = createSupabaseServiceClient();
  const { data: chunks } = await service
    .from("knowledge_chunks")
    .select("id, document_id, chunk_index, content, knowledge_documents!inner(filename, knowledge_base_id)")
    .in("knowledge_documents.knowledge_base_id", baseIds)
    .ilike("content", `%${escapeIlike(input.query.slice(0, 200))}%`)
    .limit(80);

  const scored = (chunks ?? [])
    .map((row) => {
      const doc = Array.isArray(row.knowledge_documents)
        ? row.knowledge_documents[0]
        : row.knowledge_documents;
      const filename =
        doc && typeof doc === "object" && "filename" in doc
          ? String((doc as { filename: string }).filename)
          : "document";
      return {
        document_id: String(row.document_id),
        title: filename,
        chunk: String(row.content),
        score: scoreChunk(String(row.content), input.query),
        source: "knowledge" as const,
        chunk_index: Number(row.chunk_index),
      };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? CONTEXT_BUDGET.knowledgeChunks);

  const sources: SourceCitation[] = scored.map((hit) => ({
    documentId: hit.document_id,
    filename: hit.title,
    title: hit.title,
    chunkIndex: hit.chunk_index,
    excerpt: hit.chunk.slice(0, 300),
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
  const service = createSupabaseServiceClient();
  const { error } = await service
    .from("knowledge_documents")
    .delete()
    .eq("id", documentId)
    .eq("user_id", userId);
  if (error) throw new Error("Failed to delete knowledge document");
}

export { scoreChunk, escapeIlike };
