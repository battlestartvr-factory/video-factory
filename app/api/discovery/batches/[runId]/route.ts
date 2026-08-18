import { getSessionUser } from "@/lib/auth/session";
import { apiError, apiSuccess } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import { getGameDiscoveryBatchDetail } from "@/lib/game-discovery/service";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const requestId = generateRequestId();
  const { runId } = await params;
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  try {
    const detail = await getGameDiscoveryBatchDetail({ userId: user.id, runId });
    if (!detail) return apiError("NOT_FOUND", "Discovery batch не найден", 404, requestId);
    return apiSuccess(detail);
  } catch {
    return apiError("FETCH_FAILED", "Не удалось загрузить детали discovery batch", 500, requestId);
  }
}
