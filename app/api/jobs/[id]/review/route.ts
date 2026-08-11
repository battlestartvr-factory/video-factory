import { getSessionUser, getProfile, canEditProject } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api/response";
import { reviewJobSchema } from "@/lib/validation/schemas";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { assertTransition } from "@/lib/jobs/status-transitions";
import { generateRequestId } from "@/lib/logging/logger";
import type { JobStatus } from "@/lib/types/database";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = generateRequestId();
  const { id } = await params;

  try {
    const user = await getSessionUser();
    if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

    const body = await request.json();
    const parsed = reviewJobSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);
    }

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

    if ((job.status as JobStatus) !== "review") {
      return apiError("INVALID_STATE", "Задача не на согласовании", 400, requestId);
    }

    const service = createSupabaseServiceClient();
    await service.from("reviews").insert({
      job_id: id,
      user_id: user.id,
      decision: parsed.data.decision,
      comment: parsed.data.comment ?? null,
    });

    const newStatus: JobStatus =
      parsed.data.decision === "approved" ? "completed" : "processing";
    assertTransition("review", newStatus);

    await service
      .from("jobs")
      .update({
        status: newStatus,
        completed_at: newStatus === "completed" ? new Date().toISOString() : null,
        progress: newStatus === "completed" ? 100 : job.progress,
        current_stage:
          newStatus === "completed"
            ? "Завершено"
            : "Доработка по комментарию",
      })
      .eq("id", id);

    await service.from("job_events").insert({
      job_id: id,
      event_type: `review.${parsed.data.decision}`,
      status: newStatus,
      message:
        parsed.data.decision === "approved"
          ? "Результат принят"
          : `Запрошена доработка: ${parsed.data.comment ?? ""}`,
    });

    return apiSuccess({ id, status: newStatus });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Внутренняя ошибка";
    return apiError("INTERNAL_ERROR", message, 500, requestId);
  }
}
