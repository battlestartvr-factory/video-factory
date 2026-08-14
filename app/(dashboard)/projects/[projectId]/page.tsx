import { notFound } from "next/navigation";
import { ProjectWorkspaceClient } from "@/components/projects/project-workspace-client";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Job, Project } from "@/lib/types/database";

async function getProject(id: string) {
  const supabase = await createSupabaseServerClient();
  const { data: project } = await supabase.from("projects").select("*").eq("id", id).single();
  if (!project) return null;

  const { data: jobs } = await supabase
    .from("jobs")
    .select("*")
    .eq("project_id", id)
    .order("created_at", { ascending: false });

  const { data: members } = await supabase
    .from("project_members")
    .select("user_id, member_role, profiles(email, display_name)")
    .eq("project_id", id);

  return {
    project: project as Project,
    jobs: (jobs ?? []) as Job[],
    members: members ?? [],
  };
}

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const data = await getProject(projectId);
  if (!data) notFound();

  return (
    <ProjectWorkspaceClient
      project={data.project}
      jobs={data.jobs}
      members={data.members}
    />
  );
}
