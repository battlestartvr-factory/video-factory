import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { CONTEXT_BUDGET } from "./config";
import { assembleContext, type ContextSources } from "./context-builder";
import { listMemoryForContext } from "@/lib/memory";
import { searchKnowledge } from "@/lib/knowledge";
import { truncateText } from "./redaction";
import type { Chat, ChatAttachment, ChatMessage, Preset, UserPreferences } from "@/lib/types/workspace";
import type { Project } from "@/lib/types/database";
import type { AssembledContext } from "./context-builder";

export async function loadAgentContext(input: {
  userId: string;
  chat: Chat;
  currentMessage: ChatMessage;
  modelId: string;
  presetId?: string | null;
  attachmentIds?: string[];
}): Promise<AssembledContext> {
  const service = createSupabaseServiceClient();
  const projectId = input.chat.project_id;

  const [preferencesRes, presetRes, projectRes, memory, messagesRes] = await Promise.all([
    service.from("user_preferences").select("*").eq("user_id", input.userId).maybeSingle(),
    input.presetId
      ? service.from("presets").select("*").eq("id", input.presetId).maybeSingle()
      : input.chat.preset_id
        ? service.from("presets").select("*").eq("id", input.chat.preset_id).maybeSingle()
        : Promise.resolve({ data: null }),
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

  const preset = presetRes.data as Preset | null;
  if (preset && !preset.is_system && preset.user_id !== input.userId) {
    // ignore foreign presets
  }

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

  const sources: ContextSources = {
    chat: input.chat,
    project: (projectRes.data as Project | null) ?? null,
    preset: preset && (preset.is_system || preset.user_id === input.userId) ? preset : null,
    preferences: (preferencesRes.data as UserPreferences | null) ?? null,
    memory,
    knowledgeNotes,
    recentMessages: ((messagesRes.data ?? []) as ChatMessage[]).reverse(),
    attachments,
    currentMessage: input.currentMessage,
    modelId: input.modelId,
  };

  return assembleContext(sources);
}
