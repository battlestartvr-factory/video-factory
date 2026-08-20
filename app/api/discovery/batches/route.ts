import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { apiError, apiSuccess, readJsonBody } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import { discoveryObjectiveSpecV1Schema } from "@/lib/game-discovery";
import {
  createGameDiscoveryBatch,
  listGameDiscoveryBatches,
} from "@/lib/game-discovery/service";
import { createGameDiscoveryBatchV2 } from "@/lib/game-discovery/service-v2";
import { researchPolicySpecV1Schema } from "@/lib/research-intelligence/schemas";

const createDiscoveryBatchSchema = z
  .object({
    projectId: z.string().uuid().nullable().optional(),
    hypothesis: z.string().trim().min(1).max(4_000).nullable().optional(),
    objective: discoveryObjectiveSpecV1Schema,
    // Keep v1 as the product default until PR8 production acceptance explicitly flips it.
    workflowVersion: z.union([z.literal(1), z.literal(2)]).default(1),
    researchPolicy: researchPolicySpecV1Schema.optional(),
  })
  .strict();

export async function GET(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20), 1), 100);

  try {
    const batches = await listGameDiscoveryBatches({
      userId: user.id,
      projectId: projectId || null,
      limit: Number.isFinite(limit) ? limit : 20,
    });
    return apiSuccess({ batches });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    if (message === "FORBIDDEN") {
      return apiError("FORBIDDEN", "Нет доступа к проекту", 403, requestId);
    }
    return apiError("FETCH_FAILED", "Не удалось загрузить поисковые запуски", 500, requestId);
  }
}

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
    const common = {
      requestId,
      userId: user.id,
      projectId: parsed.data.projectId ?? null,
      objective: parsed.data.objective,
      hypothesis: parsed.data.hypothesis ?? null,
    };
    const result =
      parsed.data.workflowVersion === 2
        ? await createGameDiscoveryBatchV2({
            ...common,
            researchPolicy: parsed.data.researchPolicy,
          })
        : await createGameDiscoveryBatch(common);

    return apiSuccess(
      {
        creativeRun: result.creativeRun,
        factoryJobId: result.factoryJobId,
        duplicate: result.duplicate,
        workflowVersion: parsed.data.workflowVersion,
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
