import { getSessionUser } from "@/lib/auth/session";
import { apiError, apiSuccess } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";

const KIE_CREDIT_URL = "https://api.kie.ai/api/v1/chat/credit";
const TIMEOUT_MS = 10_000;

interface KieCreditResponse {
  code?: number;
  msg?: string;
  data?: number;
}

export async function GET() {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const apiKey = (process.env.KIE_API_KEY ?? "").trim();
  if (!apiKey) {
    return apiError("KIE_NOT_CONFIGURED", "KIE API key не настроен", 503, requestId);
  }

  try {
    const response = await fetch(KIE_CREDIT_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn("kie.credits.upstream_rejected", { status: response.status });
      return apiError("KIE_CREDITS_UNAVAILABLE", "Не удалось получить баланс KIE", 502, requestId);
    }

    const payload = (await response.json()) as KieCreditResponse;
    if (payload.code !== 200 || typeof payload.data !== "number" || !Number.isFinite(payload.data)) {
      return apiError("KIE_CREDITS_INVALID", "KIE вернул некорректный баланс", 502, requestId);
    }

    return apiSuccess({
      credits: payload.data,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn("kie.credits.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return apiError("KIE_CREDITS_UNAVAILABLE", "Не удалось получить баланс KIE", 502, requestId);
  }
}
