"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";
import { ErrorState, Skeleton } from "@/components/ui/states";
import { formatUsd, formatDate } from "@/lib/utils";
import { JOB_STATUS_LABELS, JOB_TYPE_LABELS, JOB_MODE_LABELS } from "@/lib/jobs/status-transitions";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/env/env.client";
import { t } from "@/lib/i18n/dictionary";
import type { Asset, Job, JobEvent, JobStatus } from "@/lib/types/database";

export default function JobDetailPage() {
  const params = useParams<{ jobId: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revisionComment, setRevisionComment] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  const loadJob = useCallback(async () => {
    if (!isSupabaseConfigured()) {
      setLoading(false);
      return;
    }
    const supabase = getSupabaseBrowserClient();
    const { data: jobData } = await supabase
      .from("jobs")
      .select("*")
      .eq("id", params.jobId)
      .single();

    const { data: eventsData } = await supabase
      .from("job_events")
      .select("*")
      .eq("job_id", params.jobId)
      .order("created_at", { ascending: false });

    const { data: assetsData } = await supabase
      .from("assets")
      .select("*")
      .eq("job_id", params.jobId);

    setJob(jobData as Job | null);
    setEvents((eventsData ?? []) as JobEvent[]);
    setAssets((assetsData ?? []) as Asset[]);
    setLoading(false);
  }, [params.jobId]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      if (!isSupabaseConfigured()) {
        if (!cancelled) setLoading(false);
        return;
      }
      const supabase = getSupabaseBrowserClient();
      const { data: jobData } = await supabase
        .from("jobs")
        .select("*")
        .eq("id", params.jobId)
        .single();

      const { data: eventsData } = await supabase
        .from("job_events")
        .select("*")
        .eq("job_id", params.jobId)
        .order("created_at", { ascending: false });

      const { data: assetsData } = await supabase
        .from("assets")
        .select("*")
        .eq("job_id", params.jobId);

      if (cancelled) return;
      setJob(jobData as Job | null);
      setEvents((eventsData ?? []) as JobEvent[]);
      setAssets((assetsData ?? []) as Asset[]);
      setLoading(false);
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [params.jobId]);

  useEffect(() => {
    if (!isSupabaseConfigured() || !params.jobId) return;
    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      .channel(`job-${params.jobId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "jobs", filter: `id=eq.${params.jobId}` },
        () => void loadJob(),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "job_events", filter: `job_id=eq.${params.jobId}` },
        () => void loadJob(),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [params.jobId, loadJob]);

  async function postAction(path: string, body?: object) {
    setActionLoading(true);
    setError(null);
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!json.ok) {
      setError(json.error?.message ?? t("common.error"));
    } else {
      await loadJob();
    }
    setActionLoading(false);
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!job) {
    return <ErrorState message="Задача не найдена" />;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">{JOB_TYPE_LABELS[job.type] ?? job.type}</h1>
          <p className="text-sm text-zinc-500">{formatDate(job.created_at)}</p>
        </div>
        <Badge status={job.status as JobStatus} label={JOB_STATUS_LABELS[job.status as JobStatus]} />
      </div>

      {error && <ErrorState message={error} />}

      <Card>
        <CardHeader>
          <CardTitle>{t("jobs.progress")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-2 flex justify-between text-sm">
            <span className="text-zinc-400">{job.current_stage ?? "—"}</span>
            <span className="text-amber-400">{job.progress}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-500 to-amber-500 transition-all"
              style={{ width: `${job.progress}%` }}
              role="progressbar"
              aria-valuenow={job.progress}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
          {job.error_message && (
            <p className="mt-3 text-sm text-red-300">{job.error_message}</p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Параметры</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>Режим: {JOB_MODE_LABELS[job.mode]}</p>
            <p>Язык: {job.language}</p>
            <p>Платформа: {job.target_platform}</p>
            {job.brief && <p className="text-zinc-400">{job.brief}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("jobs.cost")}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p>Оценка: {formatUsd(job.estimated_cost_usd)}</p>
            <p>Факт: {formatUsd(job.actual_cost_usd)}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("jobs.timeline")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {events.length === 0 ? (
            <p className="text-sm text-zinc-500">Событий пока нет</p>
          ) : (
            events.map((ev) => (
              <div key={ev.id} className="border-l-2 border-zinc-700 pl-4">
                <p className="text-sm text-zinc-200">{ev.message ?? ev.event_type}</p>
                <p className="text-xs text-zinc-500">{formatDate(ev.created_at)}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {assets.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Результаты</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {assets.map((asset) => (
              <div key={asset.id} className="rounded-lg border border-zinc-800 p-3 text-sm">
                <p className="font-medium text-zinc-200">{asset.kind}</p>
                {asset.metadata && typeof asset.metadata === "object" && "preview" in asset.metadata && (
                  <p className="mt-1 text-zinc-400">{String(asset.metadata.preview)}</p>
                )}
                {asset.url && (
                  <a href={asset.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-amber-400 hover:underline">
                    Открыть
                  </a>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {job.status === "review" && (
        <Card>
          <CardHeader>
            <CardTitle>Согласование</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Textarea
              placeholder="Комментарий к доработке"
              value={revisionComment}
              onChange={(e) => setRevisionComment(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={actionLoading}
                onClick={() => postAction(`/api/jobs/${job.id}/review`, { decision: "approved" })}
              >
                {t("jobs.accept")}
              </Button>
              <Button
                variant="secondary"
                disabled={actionLoading}
                onClick={() =>
                  postAction(`/api/jobs/${job.id}/review`, {
                    decision: "revision_requested",
                    comment: revisionComment,
                  })
                }
              >
                {t("jobs.revision")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        {["failed", "cancelled"].includes(job.status) && (
          <Button variant="secondary" disabled={actionLoading} onClick={() => postAction(`/api/jobs/${job.id}/retry`)}>
            {t("jobs.retry")}
          </Button>
        )}
        {!["completed", "cancelled"].includes(job.status) && (
          <Button variant="destructive" disabled={actionLoading} onClick={() => postAction(`/api/jobs/${job.id}/cancel`)}>
            {t("jobs.cancel")}
          </Button>
        )}
      </div>
    </div>
  );
}
