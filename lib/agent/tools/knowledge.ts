import type { AgentTool } from "@/lib/agent/types";
import {
  addToKnowledgeSchema,
  listKnowledgeDocumentsSchema,
  searchKnowledgeSchema,
} from "@/lib/agent/schemas";
import { AGENT_ERROR_CODES } from "@/lib/agent/config";
import {
  addKnowledgeDocument,
  listKnowledgeDocuments,
  searchKnowledge,
} from "@/lib/knowledge";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { isAllowedMime } from "@/lib/attachments/mime";

function resolveProjectId(
  scope: "global" | "project" | "all" | undefined,
  chatProjectId: string | null,
): string | null {
  if (scope === "global") return null;
  return chatProjectId;
}

export const searchKnowledgeTool: AgentTool<typeof searchKnowledgeSchema._output> = {
  name: "search_knowledge",
  description:
    "Search the knowledge base (global and/or current project). Returns document_id, title, chunk, score, source. Use together with web_search when comparing internal research to the market.",
  inputSchema: searchKnowledgeSchema,
  risk: "safe",
  async handler(input, ctx) {
    const { hits, sources } = await searchKnowledge({
      userId: ctx.userId,
      query: input.query,
      scope: input.scope,
      projectId: resolveProjectId(input.scope, ctx.projectId),
    });
    return {
      ok: true,
      data: {
        hits: hits.map((hit) => ({
          documentId: hit.documentId,
          filename: hit.filename,
          title: hit.title,
          chunkId: hit.chunkId,
          chunkIndex: hit.chunkIndex,
          text: hit.text,
          score: hit.score,
          scope: hit.scope,
        })),
      },
      sources,
    };
  },
};

export const listKnowledgeDocumentsTool: AgentTool<typeof listKnowledgeDocumentsSchema._output> = {
  name: "list_knowledge_documents",
  description: "List knowledge documents in global and/or project scope.",
  inputSchema: listKnowledgeDocumentsSchema,
  risk: "safe",
  async handler(input, ctx) {
    const documents = await listKnowledgeDocuments({
      userId: ctx.userId,
      scope: input.scope,
      projectId: resolveProjectId(input.scope, ctx.projectId),
    });
    return {
      ok: true,
      data: {
        documents: documents.map((doc) => ({
          id: doc.id,
          title: doc.filename,
          mime_type: doc.mime_type,
          status: doc.status,
          tags: doc.tags,
          created_at: doc.created_at,
        })),
      },
    };
  },
};

export const addToKnowledgeTool: AgentTool<typeof addToKnowledgeSchema._output> = {
  name: "add_to_knowledge",
  description:
    "Add text or an attachment into the knowledge base (global or current project). Prefer attachment_id when the user uploaded a file.",
  inputSchema: addToKnowledgeSchema,
  risk: "safe",
  async handler(input, ctx) {
    const projectId = input.scope === "project" ? ctx.projectId : input.scope === "global" ? null : ctx.projectId;
    let filename = input.title ?? "Заметка";
    let mimeType = "text/plain";
    let content = input.content;
    let sizeBytes: number | undefined;

    if (input.attachment_id) {
      const service = createSupabaseServiceClient();
      const { data } = await service
        .from("chat_attachments")
        .select("*")
        .eq("id", input.attachment_id)
        .eq("user_id", ctx.userId)
        .maybeSingle();
      if (!data) {
        return { ok: false, code: AGENT_ERROR_CODES.NOT_FOUND, error: "Вложение не найдено" };
      }
      if (!isAllowedMime(data.mime_type)) {
        return { ok: false, code: AGENT_ERROR_CODES.VALIDATION_ERROR, error: "Неподдерживаемый тип файла" };
      }
      filename = input.title || data.filename;
      mimeType = data.mime_type;
      sizeBytes = data.size_bytes ?? undefined;
      const meta = (data.metadata ?? {}) as Record<string, unknown>;
      content =
        input.content ||
        (typeof meta.extracted_text === "string" ? meta.extracted_text : undefined) ||
        (typeof meta.text === "string" ? meta.text : undefined);
      if (!content) {
        return {
          ok: false,
          code: AGENT_ERROR_CODES.EXTRACT_UNAVAILABLE,
          error: "Текст вложения ещё не извлечён. Сначала вызовите extract_document.",
        };
      }
    }

    if (!content) {
      return { ok: false, code: AGENT_ERROR_CODES.VALIDATION_ERROR, error: "Нужен content или attachment_id" };
    }

    const doc = await addKnowledgeDocument({
      userId: ctx.userId,
      filename,
      mimeType,
      content,
      sizeBytes,
      tags: input.tags,
      projectId,
      source: input.attachment_id ? "chat_attachment" : "agent",
    });

    return {
      ok: true,
      data: { document_id: doc.id, title: doc.filename, status: doc.status },
    };
  },
};
