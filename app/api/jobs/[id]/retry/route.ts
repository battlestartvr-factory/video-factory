import { v4 as uuidv4 } from "uuid";
import { getSessionUser, getProfile, canEditProject } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api/response";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { dispatchJobToN8n } from "@/lib/n8n/client";
import { scheduleMockWorkflow } from "@/lib/n8n/mock-workflow";
import { serverEnv } from "@/lib/env/env.server";
import { generateRequestId, createLogger } from "@/lib/logging/logger";
import type { Job, JobStatus } from "@/lib/types/database";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = generateRequestId();
  const { id } = await params;

  try {
    const user = await getSessionUser();
    if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

    const supabase = await createSupabaseServerClient();
    const { data: job } = await supabase.from("jobs").select("*").eq("id", id).single();
    if (!job) return apiError("NOT_FOUND", "Задача не найдена", 404, requestId);

    const profile = await getProfile(user.id);
    const allowed = await canEditProject(
      user.id,
      job.project_id,
      profile?.role as "admin" | "member" | undefined,
    );
    if (!allowed) return apiError("FORBIDDEN", "Нет доступа", 403, requestId);

    const status = job.status as JobStatus;
    if (!["failed", "cancelled"].includes(status)) {
      return apiError("INVALID_STATE", "Повтор доступен только для failed/cancelled", 400, requestId);
    }

    await supabase
      .from("jobs")
      .update({
        status: "queued",
        progress: 0,
        current_stage: null,
        error_code: null,
        error_message: null,
        completed_at: null,
      })
      .eq("id", id);

    await supabase.from("job_events").insert({
      job_id: id,
      event_type: "job.retry",
      status: "queued",
      message: "Задача перезапущена",
      progress: 0,
    });

    const typedJob = job as Job;
    const eventId = uuidv4();
    try {
      const result = await dispatchJobToN8n({
        event: "job.created",
        eventId,
        jobId: id,
        projectId: typedJob.project_id,
        type: typedJob.type,
        mode: typedJob.mode,
        language: typedJob.language,
        targetPlatform: typedJob.target_platform,
        brief: typedJob.brief,
        source: {
          provider: typedJob.source_provider,
          externalId: typedJob.source_external_id ?? "",
          url: typedJob.source_url ?? "",
        },
        callbackUrl: `${serverEnv.APP_URL}/api/webhooks/n8n/job-update`,
        createdAt: new Date().toISOString(),
      });
      if (result.mock) scheduleMockWorkflow(id);
    } catch {
      return apiError("N8N_UNAVAILABLE", "n8n недоступен", 502, requestId);
    }

    createLogger({ requestId, jobId: id }).info("Job retried");
    return apiSuccess({ id, status: "queued" });
  } catch {
    return apiError("INTERNAL_ERROR", "Внутренняя ошибка", 500, requestId);
  }
}
