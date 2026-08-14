import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { assertProjectAccess } from "./access";
import type { Project } from "@/lib/types/database";

export async function getProjectForUser(userId: string, projectId: string): Promise<Project | null> {
  await assertProjectAccess(userId, projectId);
  const service = createSupabaseServiceClient();
  const { data } = await service.from("projects").select("*").eq("id", projectId).maybeSingle();
  return (data as Project | null) ?? null;
}

export async function createProjectForUser(input: {
  userId: string;
  name: string;
  description?: string | null;
  defaultLanguage?: string;
  targetPlatforms?: string[];
}): Promise<Project> {
  const service = createSupabaseServiceClient();
  const { data: project, error } = await service
    .from("projects")
    .insert({
      name: input.name,
      description: input.description ?? null,
      default_language: input.defaultLanguage ?? "ru",
      target_platforms: input.targetPlatforms ?? [],
      created_by: input.userId,
    })
    .select()
    .single();

  if (error || !project) {
    throw new Error("Failed to create project");
  }

  const { error: memberError } = await service.from("project_members").insert({
    project_id: project.id,
    user_id: input.userId,
    member_role: "owner",
  });
  if (memberError) {
    await service.from("projects").delete().eq("id", project.id);
    throw new Error("Failed to create project");
  }

  return project as Project;
}

export async function updateProjectInstructions(input: {
  userId: string;
  projectId: string;
  instructions: string;
}): Promise<Project> {
  await assertProjectAccess(input.userId, input.projectId);
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("projects")
    .update({ system_prompt: input.instructions })
    .eq("id", input.projectId)
    .select()
    .single();
  if (error || !data) throw new Error("Failed to update project instructions");
  return data as Project;
}

export interface ProjectFileRecord {
  id: string;
  kind: "knowledge" | "attachment" | "asset";
  filename: string;
  mimeType: string | null;
  source: string;
}

export async function listProjectFiles(userId: string, projectId: string): Promise<ProjectFileRecord[]> {
  await assertProjectAccess(userId, projectId);
  const service = createSupabaseServiceClient();
  const files: ProjectFileRecord[] = [];

  const { data: bases } = await service
    .from("knowledge_bases")
    .select("id")
    .eq("project_id", projectId);

  const baseIds = (bases ?? []).map((row: { id: string }) => row.id);
  if (baseIds.length) {
    const { data: docs } = await service
      .from("knowledge_documents")
      .select("id, filename, mime_type")
      .in("knowledge_base_id", baseIds)
      .order("created_at", { ascending: false })
      .limit(50);
    for (const doc of docs ?? []) {
      files.push({
        id: doc.id,
        kind: "knowledge",
        filename: doc.filename,
        mimeType: doc.mime_type,
        source: "knowledge",
      });
    }
  }

  const { data: chats } = await service.from("chats").select("id").eq("project_id", projectId).limit(30);
  const chatIds = (chats ?? []).map((row: { id: string }) => row.id);
  if (chatIds.length) {
    const { data: attachments } = await service
      .from("chat_attachments")
      .select("id, filename, mime_type")
      .in("chat_id", chatIds)
      .order("created_at", { ascending: false })
      .limit(50);
    for (const att of attachments ?? []) {
      files.push({
        id: att.id,
        kind: "attachment",
        filename: att.filename,
        mimeType: att.mime_type,
        source: "chat_attachment",
      });
    }
  }

  const { data: assets } = await service
    .from("assets")
    .select("id, mime_type, metadata")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(30);
  for (const asset of assets ?? []) {
    const metadata = (asset.metadata ?? {}) as Record<string, unknown>;
    files.push({
      id: asset.id,
      kind: "asset",
      filename: String(metadata.filename ?? metadata.name ?? asset.id),
      mimeType: asset.mime_type,
      source: "asset",
    });
  }

  return files.slice(0, 80);
}
