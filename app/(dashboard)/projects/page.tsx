import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils";
import { t } from "@/lib/i18n/dictionary";
import type { Project } from "@/lib/types/database";

async function getProjects(): Promise<Project[]> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase
      .from("projects")
      .select("*")
      .eq("status", "active")
      .order("updated_at", { ascending: false });
    return (data ?? []) as Project[];
  } catch {
    return [];
  }
}

export default async function ProjectsPage() {
  const projects = await getProjects();

  return (
    <div className="flex flex-1 flex-col p-4 md:p-8">
      <div className="mx-auto w-full max-w-6xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold">{t("projects.title")}</h1>
        <Button>
          <Link href="/projects/new" className="inline-flex items-center gap-2">
            <Plus className="h-4 w-4" aria-hidden />
            {t("projects.new")}
          </Link>
        </Button>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden />
        <input
          type="search"
          placeholder={t("projects.search")}
          className="h-10 w-full rounded-lg border border-zinc-700 bg-zinc-900/80 pl-10 pr-4 text-sm text-zinc-100 placeholder:text-zinc-500"
          aria-label={t("projects.search")}
        />
      </div>

      {projects.length === 0 ? (
        <EmptyState
          title={t("projects.empty")}
          description={t("projects.emptyDescription")}
          action={
            <Button>
              <Link href="/projects/new">{t("projects.new")}</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Link key={project.id} href={`/projects/${project.id}`}>
              <Card className="h-full transition-colors hover:border-amber-500/30">
                <CardHeader>
                  <CardTitle>{project.name}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="line-clamp-2 text-sm text-zinc-400">
                    {project.description || "—"}
                  </p>
                  <p className="mt-3 text-xs text-zinc-500">
                    {formatDate(project.updated_at)}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
