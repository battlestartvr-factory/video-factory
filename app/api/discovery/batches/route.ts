import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { apiError, apiSuccess, readJsonBody } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import {
  createGameDiscoveryBatch,
  discoveryObjectiveSpecV1Schema,
} from "@/lib/game-discovery";

const createDiscoveryBatchSchema = z
  .object({
    projectId: z.string().uuid().nullable().optional(),
    hypothesis: z.string().trim().min(1).max(4_000).nullable().optional(),
    objective: discoveryObjectiveSpecV1Schema,
  })
  .strict();

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const body = await readJsonBody<unknown>(request);
  const parsed = createDiscoveryBatchSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", "Некорректная цель поиска игры", 400, requestId);
  }

  try {
    const result = await createGameDiscoveryBatch({
      requestId,
      userId: user.id,
      projectId: parsed.data.projectId ?? null,
      objective: parsed.data.objective,
      hypothesis: parsed.data.hypothesis ?? null,
    });

    return apiSuccess(
      {
        creativeRun: result.creativeRun,
        factoryJobId: result.factoryJobId,
        duplicate: result.duplicate,
      },
      201,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    if (message === "FORBIDDEN") {
      return apiError("FORBIDDEN", "Нет доступа к проекту", 403, requestId);
    }
    return apiError("CREATE_FAILED", "Не удалось запустить поиск игровых концептов", 500, requestId);
  }
}
