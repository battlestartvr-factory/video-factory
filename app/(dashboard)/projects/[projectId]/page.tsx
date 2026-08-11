import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils";
import { JOB_STATUS_LABELS, JOB_TYPE_LABELS } from "@/lib/jobs/status-transitions";
import { t } from "@/lib/i18n/dictionary";
import type { Job, JobStatus, Project } from "@/lib/types/database";

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

  const { project, jobs, members } = data;

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">{project.name}</h1>
          <p className="mt-1 text-zinc-400">{project.description || "—"}</p>
          <p className="mt-2 text-xs text-zinc-500">
            Язык: {project.default_language} · Платформы:{" "}
            {project.target_platforms.join(", ") || "—"}
          </p>
        </div>
        <Button>
          <Link href={`/projects/${projectId}/jobs/new`} className="inline-flex items-center gap-2">
            <Plus className="h-4 w-4" aria-hidden />
            {t("jobs.new")}
          </Link>
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("projects.jobs")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {jobs.length === 0 ? (
              <p className="text-sm text-zinc-500">Задач пока нет</p>
            ) : (
              jobs.map((job) => (
                <Link
                  key={job.id}
                  href={`/jobs/${job.id}`}
                  className="flex items-center justify-between rounded-lg border border-zinc-800 px-4 py-3 hover:border-zinc-700"
                >
                  <div>
                    <p className="font-medium">{JOB_TYPE_LABELS[job.type] ?? job.type}</p>
                    <p className="text-xs text-zinc-500">{formatDate(job.created_at)}</p>
                  </div>
                  <Badge
                    status={job.status as JobStatus}
                    label={JOB_STATUS_LABELS[job.status as JobStatus]}
                  />
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("projects.members")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {members.map((m) => {
              const profile = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
              return (
                <div key={m.user_id} className="text-sm">
                  <p className="text-zinc-200">{profile?.display_name ?? profile?.email ?? m.user_id}</p>
                  <p className="text-xs text-zinc-500">{m.member_role}</p>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
