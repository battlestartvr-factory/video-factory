import { v4 as uuidv4 } from "uuid";
import { apiError, apiSuccess } from "@/lib/api/response";
import { checkRateLimit } from "@/lib/api/rate-limit";
import {
  requireFactoryUser,
  requireProjectEditor,
  validateSourceAssetsBelongToProject,
} from "@/lib/factory/access";
import { createFactoryJob } from "@/lib/factory/n8n-server";
import { createFactoryJobSchema } from "@/lib/factory/validation";
import { createLogger, generateRequestId } from "@/lib/logging/logger";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { UserRole } from "@/lib/types/database";

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const logger = createLogger({ requestId, event: "factory.jobs.create" });

  try {
    const auth = await requireFactoryUser();
    if (auth.error || !auth.user) {
      return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);
    }

    const rate = checkRateLimit(`factory-jobs:${auth.user.id}`, 10, 60_000);
    if (!rate.allowed) {
      return apiError("RATE_LIMITED", "Слишком много запросов", 429, requestId);
    }

    const body = await request.json();
    const parsed = createFactoryJobSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", "Некорректные данные задачи", 400, requestId);
    }

    if (parsed.data.userId && parsed.data.userId !== auth.user.id) {
      return apiError("FORBIDDEN", "userId не совпадает с сессией", 403, requestId);
    }

    const projectAccess = await requireProjectEditor(
      parsed.data.projectId,
      auth.user.id,
      auth.profile?.role as UserRole | undefined,
    );
    if (projectAccess.error) {
      return apiError("FORBIDDEN", "Нет доступа к проекту", 403, requestId);
    }

    const assetsOk = await validateSourceAssetsBelongToProject(
      parsed.data.sourceAssetIds,
      parsed.data.projectId,
    );
    if (!assetsOk) {
      return apiError(
        "INVALID_SOURCE_ASSETS",
        "Один или несколько source assets не принадлежат проекту",
        400,
        requestId,
      );
    }

    const jobRequestId = parsed.data.requestId ?? uuidv4();
    const conceptDisclosureRequired = parsed.data.contentNamespace === "ai_game_lab";
    const input = {
      prompt: parsed.data.prompt,
      variants: parsed.data.variants,
      durationSeconds: parsed.data.durationSeconds ?? null,
      aspectRatio: parsed.data.aspectRatio ?? null,
      sourceAssetIds: parsed.data.sourceAssetIds,
      metadata: parsed.data.metadata,
    };

    const service = createSupabaseServiceClient();
    const { data: rpcResult, error: rpcError } = await service.rpc(
      "factory_create_or_get_job",
      {
        payload: {
          request_id: jobRequestId,
          project_id: parsed.data.projectId,
          user_id: auth.user.id,
          job_type: parsed.data.jobType,
          preset: parsed.data.preset,
          content_namespace: parsed.data.contentNamespace,
          concept_disclosure_required: conceptDisclosureRequired,
          input,
        },
      },
    );

    if (rpcError || !rpcResult) {
      logger.error("factory_create_or_get_job failed", { message: rpcError?.message });
      return apiError("CREATE_FAILED", "Не удалось создать factory job", 500, requestId);
    }

    const result = rpcResult as {
      job_id: string;
      status: string;
      duplicate: boolean;
    };

    const n8nPayload = {
      event: "factory.job.created" as const,
      requestId: jobRequestId,
      jobId: result.job_id,
      projectId: parsed.data.projectId,
      userId: auth.user.id,
      jobType: parsed.data.jobType,
      preset: parsed.data.preset,
      contentNamespace: parsed.data.contentNamespace,
      conceptDisclosureRequired,
      input,
      createdAt: new Date().toISOString(),
    };

    try {
      const dispatch = await createFactoryJob(n8nPayload);
      logger.info("Factory job accepted", {
        jobId: result.job_id,
        duplicate: result.duplicate,
        mock: dispatch.mock,
      });
    } catch (error) {
      const message =
        error instanceof Error && error.message === "FACTORY_N8N_TIMEOUT"
          ? "Таймаут n8n factory webhook"
          : "n8n factory webhook недоступен";
      const status =
        error instanceof Error && error.message === "FACTORY_N8N_TIMEOUT" ? 504 : 502;
      return apiError("FACTORY_N8N_UNAVAILABLE", message, status, requestId);
    }

    return apiSuccess(
      {
        jobId: result.job_id,
        requestId: jobRequestId,
        status: result.status,
        accepted: true as const,
        duplicate: result.duplicate,
      },
      202,
    );
  } catch {
    return apiError("INTERNAL_ERROR", "Внутренняя ошибка", 500, requestId);
  }
}
