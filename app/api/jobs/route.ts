import { v4 as uuidv4 } from "uuid";
import { getSessionUser, getProfile, canEditProject } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api/response";
import { checkRateLimit } from "@/lib/api/rate-limit";
import { createJobSchema } from "@/lib/validation/schemas";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { getStorageProvider } from "@/lib/storage/providers";
import { dispatchJobToN8n } from "@/lib/n8n/client";
import { scheduleMockWorkflow } from "@/lib/n8n/mock-workflow";
import { serverEnv, isGoogleDriveConfigured } from "@/lib/env/env.server";
import { generateRequestId, createLogger } from "@/lib/logging/logger";

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const logger = createLogger({ requestId, event: "jobs.create" });

  try {
    const user = await getSessionUser();
    if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

    const rate = checkRateLimit(`jobs:${user.id}`, 10, 60_000);
    if (!rate.allowed) {
      return apiError("RATE_LIMITED", "Слишком много запросов", 429, requestId);
    }

    const body = await request.json();
    const parsed = createJobSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", "Некорректные данные задачи", 400, requestId);
    }

    const profile = await getProfile(user.id);
    const allowed = await canEditProject(
      user.id,
      parsed.data.projectId,
      profile?.role as "admin" | "member" | undefined,
    );
    if (!allowed) {
      return apiError("FORBIDDEN", "Нет доступа к проекту", 403, requestId);
    }

    const storage = getStorageProvider(isGoogleDriveConfigured());
    let sourceRef;
    try {
      sourceRef = await storage.validateReference(parsed.data.sourceInput);
    } catch {
      return apiError("INVALID_SOURCE", "Некорректная ссылка Google Drive", 400, requestId);
    }

    const supabase = await createSupabaseServerClient();
    const { data: job, error } = await supabase
      .from("jobs")
      .insert({
        project_id: parsed.data.projectId,
        created_by: user.id,
        type: parsed.data.type,
        status: "queued",
        mode: parsed.data.mode,
        language: parsed.data.language,
        target_platform: parsed.data.targetPlatform,
        brief: parsed.data.brief ?? null,
        source_provider: sourceRef.provider,
        source_external_id: sourceRef.externalId,
        source_url: sourceRef.url,
        progress: 0,
      })
      .select()
      .single();

    if (error || !job) {
      logger.error("Job insert failed");
      return apiError("CREATE_FAILED", "Не удалось создать задачу", 500, requestId);
    }

    await supabase.from("job_events").insert({
      job_id: job.id,
      event_type: "job.created",
      status: "queued",
      message: "Задача поставлена в очередь",
      progress: 0,
    });

    const eventId = uuidv4();
    const payload = {
      event: "job.created" as const,
      eventId,
      jobId: job.id,
      projectId: parsed.data.projectId,
      type: parsed.data.type,
      mode: parsed.data.mode,
      language: parsed.data.language,
      targetPlatform: parsed.data.targetPlatform,
      brief: parsed.data.brief ?? null,
      source: {
        provider: sourceRef.provider,
        externalId: sourceRef.externalId,
        url: sourceRef.url,
      },
      callbackUrl: `${serverEnv.APP_URL}/api/webhooks/n8n/job-update`,
      createdAt: new Date().toISOString(),
    };

    try {
      const result = await dispatchJobToN8n(payload);
      if (result.mock) {
        scheduleMockWorkflow(job.id);
      }
    } catch {
      await createSupabaseServiceClient()
        .from("jobs")
        .update({
          status: "failed",
          error_code: "N8N_DISPATCH_FAILED",
          error_message: "Не удалось отправить задачу в n8n. Повторите позже.",
        })
        .eq("id", job.id);
      return apiError(
        "N8N_UNAVAILABLE",
        "n8n недоступен. Задача создана, но не отправлена — используйте «Повторить».",
        502,
        requestId,
      );
    }

    logger.info("Job created", { jobId: job.id, userId: user.id });
    return apiSuccess(job, 201);
  } catch {
    return apiError("INTERNAL_ERROR", "Внутренняя ошибка", 500, requestId);
  }
}
