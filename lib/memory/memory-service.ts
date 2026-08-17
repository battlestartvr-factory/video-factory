import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { CONTEXT_BUDGET } from "@/lib/agent/config";
import { assertProjectAccess } from "@/lib/projects/access";
import type { MemoryItem, MemoryScope } from "@/lib/types/workspace";

export async function listMemoryForContext(input: {
  userId: string;
  projectId?: string | null;
  limit?: number;
}): Promise<MemoryItem[]> {
  const service = createSupabaseServiceClient();
  const limit = input.limit ?? CONTEXT_BUDGET.memoryItems;

  const { data: globalItems } = await service
    .from("memory_items")
    .select("*")
    .eq("user_id", input.userId)
    .eq("scope", "global")
    .eq("enabled", true)
    .order("pinned", { ascending: false })
    .order("importance", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(limit);

  const items = (globalItems ?? []) as MemoryItem[];
  if (!input.projectId) return items;

  await assertProjectAccess(input.userId, input.projectId);
  const { data: projectItems } = await service
    .from("memory_items")
    .select("*")
    .eq("user_id", input.userId)
    .eq("scope", "project")
    .eq("project_id", input.projectId)
    .eq("enabled", true)
    .order("pinned", { ascending: false })
    .order("importance", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(limit);

  return [...items, ...((projectItems ?? []) as MemoryItem[])].slice(0, limit);
}

export async function searchMemory(input: {
  userId: string;
  query: string;
  scope?: "global" | "project" | "all";
  projectId?: string | null;
}): Promise<MemoryItem[]> {
  const service = createSupabaseServiceClient();
  const scope = input.scope ?? (input.projectId ? "all" : "global");
  let query = service
    .from("memory_items")
    .select("*")
    .eq("user_id", input.userId)
    .eq("enabled", true)
    .ilike("content", `%${input.query.replace(/[%_]/g, "\\$&")}%`)
    .order("pinned", { ascending: false })
    .order("importance", { ascending: false })
    .limit(20);

  if (scope === "global") query = query.eq("scope", "global");
  if (scope === "project") {
    if (!input.projectId) return [];
    await assertProjectAccess(input.userId, input.projectId);
    query = query.eq("scope", "project").eq("project_id", input.projectId);
  }
  if (scope === "all" && input.projectId) {
    await assertProjectAccess(input.userId, input.projectId);
    query = query.or(`scope.eq.global,and(scope.eq.project,project_id.eq.${input.projectId})`);
  }

  const { data } = await query;
  return (data ?? []) as MemoryItem[];
}

export async function saveMemory(input: {
  userId: string;
  content: string;
  scope?: MemoryScope;
  projectId?: string | null;
  category?: string;
  source?: string;
  importance?: number;
  sourceRunId?: string | null;
  confidence?: number | null;
  evidence?: unknown[];
  learnedFrom?: string | null;
}): Promise<MemoryItem> {
  const scope = input.scope ?? (input.projectId ? "project" : "global");
  if (scope === "project") {
    if (!input.projectId) throw new Error("projectId required");
    await assertProjectAccess(input.userId, input.projectId);
  }
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("memory_items")
    .insert({
      user_id: input.userId,
      scope,
      project_id: scope === "project" ? input.projectId : null,
      content: input.content,
      category: input.category ?? null,
      source: input.source ?? "agent",
      importance: input.importance ?? 5,
      source_run_id: input.sourceRunId ?? null,
      confidence: input.confidence ?? null,
      evidence: input.evidence ?? [],
      learned_from: input.learnedFrom ?? null,
    })
    .select()
    .single();
  if (error || !data) throw new Error("Failed to save memory");
  return data as MemoryItem;
}

export async function updateMemory(input: {
  userId: string;
  memoryId: string;
  content?: string;
  category?: string | null;
  importance?: number;
  pinned?: boolean;
  enabled?: boolean;
  confidence?: number | null;
  evidence?: unknown[];
}): Promise<MemoryItem> {
  const service = createSupabaseServiceClient();
  const { data: existing } = await service
    .from("memory_items")
    .select("id")
    .eq("id", input.memoryId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (!existing) {
    const error = new Error("NOT_FOUND");
    error.name = "NotFoundError";
    throw error;
  }

  const updates: Record<string, unknown> = {};
  if (input.content !== undefined) updates.content = input.content;
  if (input.category !== undefined) updates.category = input.category;
  if (input.importance !== undefined) updates.importance = input.importance;
  if (input.pinned !== undefined) updates.pinned = input.pinned;
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  if (input.confidence !== undefined) updates.confidence = input.confidence;
  if (input.evidence !== undefined) updates.evidence = input.evidence;

  const { data, error } = await service
    .from("memory_items")
    .update(updates)
    .eq("id", input.memoryId)
    .select()
    .single();
  if (error || !data) throw new Error("Failed to update memory");
  return data as MemoryItem;
}

export async function listMemoryItems(input: {
  userId: string;
  scope?: string | null;
  projectId?: string | null;
  search?: string | null;
}): Promise<MemoryItem[]> {
  const service = createSupabaseServiceClient();
  let query = service
    .from("memory_items")
    .select("*")
    .eq("user_id", input.userId)
    .order("pinned", { ascending: false })
    .order("importance", { ascending: false })
    .order("updated_at", { ascending: false });
  if (input.scope) query = query.eq("scope", input.scope);
  if (input.projectId) query = query.eq("project_id", input.projectId);
  if (input.search) query = query.ilike("content", `%${input.search}%`);
  const { data } = await query;
  return (data ?? []) as MemoryItem[];
}

export async function deleteMemory(userId: string, memoryId: string): Promise<void> {
  const service = createSupabaseServiceClient();
  const { error } = await service
    .from("memory_items")
    .delete()
    .eq("id", memoryId)
    .eq("user_id", userId);
  if (error) throw new Error("Failed to delete memory");
}
