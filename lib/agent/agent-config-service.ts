import "server-only";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { DEFAULT_GLOBAL_AGENT_INSTRUCTIONS } from "./default-agent-instructions";

export interface AgentConfig {
  id: string;
  user_id: string;
  name: string;
  system_prompt: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export async function getAgentConfig(userId: string): Promise<AgentConfig | null> {
  const service = createSupabaseServiceClient();
  const { data } = await service
    .from("agent_configs")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as AgentConfig | null) ?? null;
}

export async function getOrCreateAgentConfig(userId: string): Promise<AgentConfig> {
  const existing = await getAgentConfig(userId);
  if (existing) return existing;

  const service = createSupabaseServiceClient();
  const { data: prefs } = await service
    .from("user_preferences")
    .select("personalization")
    .eq("user_id", userId)
    .maybeSingle();

  const personalization = (prefs?.personalization ?? {}) as { globalInstructions?: string };
  const initialPrompt =
    personalization.globalInstructions?.trim() || DEFAULT_GLOBAL_AGENT_INSTRUCTIONS;

  const { data, error } = await service
    .from("agent_configs")
    .insert({
      user_id: userId,
      name: "default",
      system_prompt: initialPrompt,
      version: 1,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error("Failed to create agent config");
  }
  return data as AgentConfig;
}

export async function updateAgentConfig(
  userId: string,
  systemPrompt: string,
): Promise<AgentConfig> {
  await getOrCreateAgentConfig(userId);
  const service = createSupabaseServiceClient();
  const { data: current } = await service
    .from("agent_configs")
    .select("version")
    .eq("user_id", userId)
    .single();

  const nextVersion = ((current?.version as number | undefined) ?? 0) + 1;
  const { data, error } = await service
    .from("agent_configs")
    .update({
      system_prompt: systemPrompt,
      version: nextVersion,
    })
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error("Failed to update agent config");
  }
  return data as AgentConfig;
}

export async function resetAgentConfig(userId: string): Promise<AgentConfig> {
  return updateAgentConfig(userId, DEFAULT_GLOBAL_AGENT_INSTRUCTIONS);
}
