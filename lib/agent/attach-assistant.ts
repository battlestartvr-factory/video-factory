import "server-only";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/** Persist the assistant message that closed a universal-agent run. */
export async function attachAssistantToRun(
  agentRunId: string,
  assistantMessageId: string,
): Promise<void> {
  if (!agentRunId) return;
  const service = createSupabaseServiceClient();
  await service
    .from("agent_runs")
    .update({ assistant_message_id: assistantMessageId })
    .eq("id", agentRunId);
}
