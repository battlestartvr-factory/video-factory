import "server-only";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export async function attachAssistantToRun(agentRunId: string, assistantMessageId: string) {
  if (!agentRunId) return;
  const service = createSupabaseServiceClient();
  await service
    .from("agent_runs")
    .update({ assistant_message_id: assistantMessageId })
    .eq("id", agentRunId);
}
