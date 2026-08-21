import { getSessionUser } from "@/lib/auth/session";
import { apiError, apiSuccess } from "@/lib/api/response";
import { earlyFinalizeGameDiscoveryResearch } from "@/lib/game-discovery/early-finalize";
import { generateRequestId } from "@/lib/logging/logger";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const { runId } = await params;
  try {
    const result = await earlyFinalizeGameDiscoveryResearch({ userId: user.id, runId });
    if (!result) return apiError("NOT_FOUND", "Discovery batch не найден", 404, requestId);
    if (!result.accepted) {
      return apiError(
        "EARLY_FINALIZE_NOT_ELIGIBLE",
        result.reason ?? "Данных для досрочного ответа пока недостаточно",
        409,
        requestId,
      );
    }
    return apiSuccess(result);
  } catch (error) {
    return apiError(
      "EARLY_FINALIZE_FAILED",
      error instanceof Error ? error.message : "Не удалось завершить research досрочно",
      500,
      requestId,
    );
  }
}
