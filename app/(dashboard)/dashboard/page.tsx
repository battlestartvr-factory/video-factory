import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatUsd, formatDate } from "@/lib/utils";
import { JOB_STATUS_LABELS, JOB_TYPE_LABELS } from "@/lib/jobs/status-transitions";
import { t } from "@/lib/i18n/dictionary";
import type { Job, JobStatus } from "@/lib/types/database";

async function getDashboardData() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: jobs } = await supabase
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);

    const allJobs = (jobs ?? []) as Job[];
    const active = allJobs.filter((j) =>
      ["queued", "processing"].includes(j.status),
    ).length;
    const review = allJobs.filter((j) => j.status === "review").length;
    const completed = allJobs.filter((j) => j.status === "completed").length;
    const failed = allJobs.filter((j) => j.status === "failed").length;

    const monthStart = new Date();
    monthStart.setDate(1);
    const { data: usage } = await supabase
      .from("usage_records")
      .select("cost_usd")
      .gte("created_at", monthStart.toISOString());

    const monthlyCost = (usage ?? []).reduce(
      (sum, r) => sum + Number(r.cost_usd ?? 0),
      0,
    );

    return { jobs: allJobs.slice(0, 8), stats: { active, review, completed, failed, monthlyCost } };
  } catch {
    return { jobs: [], stats: { active: 0, review: 0, completed: 0, failed: 0, monthlyCost: 0 } };
  }
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-normal text-zinc-400">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold text-zinc-100">{value}</p>
      </CardContent>
    </Card>
  );
}

export default async function DashboardPage() {
  const { jobs, stats } = await getDashboardData();

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-zinc-100">{t("dashboard.title")}</h1>
        <Button>
          <Link href="/projects" className="inline-flex items-center gap-2">
            <Plus className="h-4 w-4" aria-hidden />
            {t("dashboard.createJob")}
          </Link>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label={t("dashboard.activeJobs")} value={stats.active} />
        <StatCard label={t("dashboard.pendingReview")} value={stats.review} />
        <StatCard label={t("dashboard.completed")} value={stats.completed} />
        <StatCard label={t("dashboard.failed")} value={stats.failed} />
        <StatCard label={t("dashboard.monthlyCost")} value={formatUsd(stats.monthlyCost)} />
      </div>

      <section>
        <h2 className="mb-4 text-lg font-semibold text-zinc-200">
          {t("dashboard.recentJobs")}
        </h2>
        {jobs.length === 0 ? (
          <EmptyState title={t("dashboard.empty")} />
        ) : (
          <div className="space-y-2">
            {jobs.map((job) => (
              <Link
                key={job.id}
                href={`/jobs/${job.id}`}
                className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 transition-colors hover:border-zinc-700"
              >
                <div>
                  <p className="font-medium text-zinc-200">
                    {JOB_TYPE_LABELS[job.type] ?? job.type}
                  </p>
                  <p className="text-xs text-zinc-500">{formatDate(job.created_at)}</p>
                </div>
                <Badge
                  status={job.status as JobStatus}
                  label={JOB_STATUS_LABELS[job.status as JobStatus] ?? job.status}
                />
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
