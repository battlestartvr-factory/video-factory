import { v4 as uuidv4 } from "uuid";
import { apiError, apiSuccess } from "@/lib/api/response";
import { checkRateLimit } from "@/lib/api/rate-limit";
import {
  getFactoryJobForUser,
  requireFactoryUser,
  validateFactoryAssetBelongsToJob,
} from "@/lib/factory/access";
import { sendFactoryJobAction } from "@/lib/factory/n8n-server";
import { factoryJobActionSchema } from "@/lib/factory/validation";
import { createLogger, generateRequestId } from "@/lib/logging/logger";
import type { UserRole } from "@/lib/types/database";

type RouteContext = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const requestId = generateRequestId();
  const { jobId } = await context.params;
  const logger = createLogger({ requestId, event: "factory.jobs.action", jobId });

  try {
    const auth = await requireFactoryUser();
    if (auth.error || !auth.user) {
      return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);
    }

    const rate = checkRateLimit(`factory-actions:${auth.user.id}`, 20, 60_000);
    if (!rate.allowed) {
      return apiError("RATE_LIMITED", "Слишком много запросов", 429, requestId);
    }

    const body = await request.json();
    const parsed = factoryJobActionSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", "Некорректные данные действия", 400, requestId);
    }

    if (parsed.data.userId && parsed.data.userId !== auth.user.id) {
      return apiError("FORBIDDEN", "userId не совпадает с сессией", 403, requestId);
    }

    const jobResult = await getFactoryJobForUser(
      jobId,
      auth.user.id,
      auth.profile?.role as UserRole | undefined,
    );
    if (jobResult.error || !jobResult.job) {
      const status = jobResult.error === "FORBIDDEN" ? 403 : 404;
      const code = jobResult.error === "FORBIDDEN" ? "FORBIDDEN" : "NOT_FOUND";
      const message =
        jobResult.error === "FORBIDDEN" ? "Нет доступа к задаче" : "Задача не найдена";
      return apiError(code, message, status, requestId);
    }

    if (parsed.data.decision === "approve" && parsed.data.selectedAssetId) {
      const assetOk = await validateFactoryAssetBelongsToJob(
        parsed.data.selectedAssetId,
        jobId,
        parsed.data.stage,
      );
      if (!assetOk) {
        return apiError(
          "INVALID_ASSET",
          "selectedAssetId не принадлежит задаче или этапу",
          400,
          requestId,
        );
      }
    }

    const actionRequestId = parsed.data.requestId ?? uuidv4();
    const n8nPayload = {
      event: "factory.job.action" as const,
      requestId: actionRequestId,
      jobId,
      projectId: jobResult.job.project_id,
      userId: auth.user.id,
      decision: parsed.data.decision,
      stage: parsed.data.stage,
      comment: parsed.data.comment ?? null,
      selectedAssetId: parsed.data.selectedAssetId ?? null,
      createdAt: new Date().toISOString(),
    };

    try {
      const dispatch = await sendFactoryJobAction(n8nPayload);
      logger.info("Factory job action dispatched", {
        decision: parsed.data.decision,
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
        jobId,
        requestId: actionRequestId,
        decision: parsed.data.decision,
        accepted: true as const,
      },
      202,
    );
  } catch {
    return apiError("INTERNAL_ERROR", "Внутренняя ошибка", 500, requestId);
  }
}
