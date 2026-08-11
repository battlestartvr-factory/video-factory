import { getSessionUser, getProfile, canEditProject } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api/response";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { assertTransition } from "@/lib/jobs/status-transitions";
import { generateRequestId, createLogger } from "@/lib/logging/logger";
import type { JobStatus } from "@/lib/types/database";

async function getJobWithAccess(jobId: string, userId: string) {
  const supabase = await createSupabaseServerClient();
  const { data: job } = await supabase.from("jobs").select("*").eq("id", jobId).single();
  if (!job) return null;

  const profile = await getProfile(userId);
  const allowed = await canEditProject(
    userId,
    job.project_id,
    profile?.role as "admin" | "member" | undefined,
  );
  if (!allowed) return null;
  return job;
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = generateRequestId();
  const { id } = await params;

  try {
    const user = await getSessionUser();
    if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

    const job = await getJobWithAccess(id, user.id);
    if (!job) return apiError("NOT_FOUND", "Задача не найдена", 404, requestId);

    const currentStatus = job.status as JobStatus;
    if (!["queued", "processing", "review"].includes(currentStatus)) {
      return apiError("INVALID_STATE", "Задачу нельзя отменить", 400, requestId);
    }

    assertTransition(currentStatus, "cancelled");

    const service = createSupabaseServiceClient();
    await service
      .from("jobs")
      .update({ status: "cancelled", completed_at: new Date().toISOString() })
      .eq("id", id);

    await service.from("job_events").insert({
      job_id: id,
      event_type: "job.cancelled",
      status: "cancelled",
      message: "Задача отменена пользователем",
    });

    createLogger({ requestId, jobId: id }).info("Job cancelled");
    return apiSuccess({ id, status: "cancelled" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Внутренняя ошибка";
    return apiError("INTERNAL_ERROR", message, 500, requestId);
  }
}
