import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { apiSuccess, apiError, readJsonBody } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import { knowledgeUploadSchema, knowledgeQuerySchema } from "@/lib/validation/workspace-schemas";
import { isAllowedMime } from "@/lib/attachments/mime";
import type { KnowledgeBase, KnowledgeDocument } from "@/lib/types/workspace";

async function getOrCreateDefaultBase(userId: string): Promise<KnowledgeBase> {
  const service = createSupabaseServiceClient();
  const { data: existing } = await service
    .from("knowledge_bases")
    .select("*")
    .eq("user_id", userId)
    .is("project_id", null)
    .limit(1)
    .single();

  if (existing) return existing as KnowledgeBase;

  const { data, error } = await service
    .from("knowledge_bases")
    .insert({ user_id: userId, name: "Основная база" })
    .select()
    .single();

  if (error || !data) throw new Error("Failed to create knowledge base");
  return data as KnowledgeBase;
}

function chunkText(text: string, chunkSize = 1000): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if ((current + para).length > chunkSize && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.slice(0, chunkSize)];
}

export async function GET() {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const service = createSupabaseServiceClient();
  const base = await getOrCreateDefaultBase(user.id);

  const { data, error } = await service
    .from("knowledge_documents")
    .select("*")
    .eq("knowledge_base_id", base.id)
    .order("created_at", { ascending: false });

  if (error) return apiError("FETCH_FAILED", "Не удалось загрузить документы", 500, requestId);

  return apiSuccess({ knowledgeBase: base, documents: (data ?? []) as KnowledgeDocument[] });
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

  const service = createSupabaseServiceClient();
  let baseId = parsed.data.knowledgeBaseId;
  if (!baseId) {
    const base = await getOrCreateDefaultBase(user.id);
    baseId = base.id;
  }

  const { data: doc, error } = await service
    .from("knowledge_documents")
    .insert({
      knowledge_base_id: baseId,
      user_id: user.id,
      filename: parsed.data.filename,
      mime_type: parsed.data.mimeType,
      size_bytes: parsed.data.sizeBytes ?? null,
      status: "processing",
      tags: parsed.data.tags ?? [],
      source: "upload",
    })
    .select()
    .single();

  if (error || !doc) return apiError("CREATE_FAILED", "Не удалось загрузить документ", 500, requestId);

  const textContent = parsed.data.content ?? `[Содержимое ${parsed.data.filename} будет извлечено при обработке]`;
  const chunks = chunkText(textContent);

  await service.from("knowledge_documents").update({
    status: "ready",
    extracted_text: textContent.slice(0, 50000),
  }).eq("id", doc.id);

  for (let i = 0; i < chunks.length; i++) {
    await service.from("knowledge_chunks").insert({
      document_id: doc.id,
      chunk_index: i,
      content: chunks[i],
      metadata: { filename: parsed.data.filename },
    });
  }

  const { data: updated } = await service
    .from("knowledge_documents")
    .select("*")
    .eq("id", doc.id)
    .single();

  return apiSuccess(updated as KnowledgeDocument, 201);
}

export async function DELETE(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return apiError("VALIDATION_ERROR", "id обязателен", 400, requestId);

  const service = createSupabaseServiceClient();
  const { error } = await service
    .from("knowledge_documents")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) return apiError("DELETE_FAILED", "Не удалось удалить документ", 500, requestId);
  return apiSuccess({ deleted: true });
}

export async function PUT(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const body = await readJsonBody<unknown>(request);
  const parsed = knowledgeQuerySchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);

  const service = createSupabaseServiceClient();
  const base = parsed.data.knowledgeBaseId
    ? { id: parsed.data.knowledgeBaseId }
    : await getOrCreateDefaultBase(user.id);

  const { data: chunks } = await service
    .from("knowledge_chunks")
    .select("*, knowledge_documents!inner(filename, knowledge_base_id)")
    .eq("knowledge_documents.knowledge_base_id", base.id)
    .limit(100);

  const query = parsed.data.query.toLowerCase();
  const matched = (chunks ?? [])
    .filter((c: { content: string }) => c.content.toLowerCase().includes(query))
    .slice(0, 5)
    .map((c: { content: string; chunk_index: number; document_id: string; knowledge_documents: { filename: string } }) => ({
      documentId: c.document_id,
      filename: c.knowledge_documents.filename,
      chunkIndex: c.chunk_index,
      excerpt: c.content.slice(0, 300),
    }));

  return apiSuccess({
    answer: matched.length
      ? `Найдено ${matched.length} релевантных фрагментов. Полный RAG-ответ будет подключён на следующем этапе.`
      : "По вашему запросу ничего не найдено в базе знаний.",
    sources: matched,
  });
}
