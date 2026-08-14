import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { userHasProjectAccess } from "@/lib/projects/access";
import { redactForStorage } from "@/lib/agent/redaction";
import type { AgentAction } from "@/lib/types/workspace";

export interface CreateActionInput {
  userId: string;
  actionType: string;
  agentRunId?: string | null;
  chatId?: string | null;
  projectId?: string | null;
  generationId?: string | null;
  sourceMessageId?: string | null;
  input?: Record<string, unknown>;
  status?: AgentAction["status"];
}

export async function createAgentAction(input: CreateActionInput): Promise<AgentAction> {
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("agent_actions")
    .insert({
      agent_run_id: input.agentRunId ?? null,
      user_id: input.userId,
      chat_id: input.chatId ?? null,
      project_id: input.projectId ?? null,
      generation_id: input.generationId ?? null,
      source_message_id: input.sourceMessageId ?? null,
      action_type: input.actionType,
      status: input.status ?? "pending_dispatch",
      input: redactForStorage(input.input ?? {}),
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error("Failed to create agent action");
  }
  return data as AgentAction;
}

export async function attachActionGeneration(actionId: string, generationId: string) {
  const service = createSupabaseServiceClient();
  await service.from("agent_actions").update({ generation_id: generationId }).eq("id", actionId);
}

export { userHasProjectAccess };
