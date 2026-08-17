import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { CONTEXT_BUDGET } from "./config";
import { buildAgentContext, type AgentContext, type ContextSources } from "./context-builder";
import { listMemoryForContext } from "@/lib/memory";
import { searchKnowledge } from "@/lib/knowledge";
import { truncateText } from "./redaction";
import type { Chat, ChatAttachment, ChatMessage } from "@/lib/types/workspace";
import type { Project } from "@/lib/types/database";

export async function loadContextSources(input: {
  userId: string;
  chat: Chat;
  currentMessage: ChatMessage;
  modelId: string;
  /** @deprecated Ignored. */
  presetId?: string | null;
  attachmentIds?: string[];
}): Promise<ContextSources> {
  const service = createSupabaseServiceClient();
  const projectId = input.chat.project_id;

  const [projectRes, memory, messagesRes] = await Promise.all([
    projectId
      ? service.from("projects").select("*").eq("id", projectId).maybeSingle()
      : Promise.resolve({ data: null }),
    listMemoryForContext({ userId: input.userId, projectId }),
    service
      .from("chat_messages")
      .select("*")
      .eq("chat_id", input.chat.id)
      .order("created_at", { ascending: false })
      .limit(CONTEXT_BUDGET.recentMessages),
  ]);

  let attachments: ChatAttachment[] = [];
  const ids = input.attachmentIds?.length
    ? input.attachmentIds
    : ((input.currentMessage.metadata?.attachments as string[] | undefined) ?? []);
  if (ids.length) {
    const { data } = await service
      .from("chat_attachments")
      .select("*")
      .in("id", ids)
      .eq("user_id", input.userId);
    attachments = (data ?? []) as ChatAttachment[];
  }

  let knowledgeNotes: string[] = [];
  const query = input.currentMessage.content.trim();
  if (query.length >= 8) {
    try {
      const { hits } = await searchKnowledge({
        userId: input.userId,
        query,
        scope: projectId ? "all" : "global",
        projectId,
        limit: 3,
      });
      knowledgeNotes = hits.map(
        (hit) => `${hit.title} (score ${hit.score.toFixed(2)}):\n${truncateText(hit.text, 800)}`,
      );
    } catch {
      knowledgeNotes = [];
    }
  }

  return {
    chat: input.chat,
    project: (projectRes.data as Project | null) ?? null,
    preset: null,
    agentConfig: null,
    preferences: null,
    memory,
    knowledgeNotes,
    recentMessages: ((messagesRes.data ?? []) as ChatMessage[]).reverse(),
    attachments,
    currentMessage: input.currentMessage,
    modelId: input.modelId,
  };
}

export async function loadAgentContext(input: {
  userId: string;
  chat: Chat;
  currentMessage: ChatMessage;
  modelId: string;
  /** @deprecated Ignored. */
  presetId?: string | null;
  attachmentIds?: string[];
}): Promise<AgentContext> {
  const sources = await loadContextSources(input);
  return buildAgentContext(sources);
}
