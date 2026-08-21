import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { apiError, apiSuccess, readJsonBody } from "@/lib/api/response";
import { cancelGameDiscoveryBatch } from "@/lib/game-discovery/cancellation";
import { generateRequestId } from "@/lib/logging/logger";

const cancelSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const { runId } = await params;
  let body: unknown = {};
  try {
    body = await readJsonBody<unknown>(request);
  } catch {
    body = {};
  }
  const parsed = cancelSchema.safeParse(body ?? {});
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Некорректный запрос остановки", 400, requestId);

  try {
    const result = await cancelGameDiscoveryBatch({
      userId: user.id,
      runId,
      reason: parsed.data.reason ?? "user_stop",
    });
    if (!result) return apiError("NOT_FOUND", "Discovery batch не найден", 404, requestId);
    return apiSuccess(result);
  } catch (error) {
    return apiError(
      "CANCEL_FAILED",
      error instanceof Error ? error.message : "Не удалось остановить discovery batch",
      500,
      requestId,
    );
  }
}
