import { createLogger } from "@/lib/logging/logger";
import { PROVIDER_ERROR_CODES } from "./types";

const kieLogger = createLogger({ component: "kie_provider" });

export class KieProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "KieProviderError";
  }
}

export type KieHttpErrorCategory =
  | "authentication"
  | "wrong_endpoint"
  | "invalid_request"
  | "rate_limit"
  | "provider_failure";

export function classifyKieHttpStatus(status: number): KieHttpErrorCategory {
  if (status === 401 || status === 403) return "authentication";
  if (status === 404) return "wrong_endpoint";
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 429) return "rate_limit";
  return "provider_failure";
}

export function parseKieErrorBody(body?: string): {
  providerErrorCode?: string;
  providerErrorType?: string;
  requestId?: string;
} {
  if (!body?.trim()) return {};
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error =
      parsed.error && typeof parsed.error === "object"
        ? (parsed.error as Record<string, unknown>)
        : undefined;

    const providerErrorCode = pickNonEmptyString(parsed.code, error?.code);
    const providerErrorType = pickNonEmptyString(error?.type, parsed.type);
    const requestId = pickNonEmptyString(
      parsed.id,
      parsed.responseId,
      parsed.request_id,
      error?.request_id,
    );

    return {
      ...(providerErrorCode ? { providerErrorCode } : {}),
      ...(providerErrorType ? { providerErrorType } : {}),
      ...(requestId ? { requestId } : {}),
    };
  } catch {
    return {};
  }
}

function pickNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

export interface KieProviderDiagnostics {
  model_id: string;
  adapter: string;
  endpoint: string;
  http_status: number;
  http_error_category: KieHttpErrorCategory;
  normalized_error_code: string;
  provider_error_code?: string;
  provider_error_type?: string;
  request_id?: string;
}

export function logKieProviderError(diagnostics: KieProviderDiagnostics): void {
  kieLogger.error("kie_provider_request_failed", { ...diagnostics });
}

export function normalizeKieError(status: number, body?: string): KieProviderError {
  const parsed = parseKieErrorBody(body);
  const lower = (body ?? "").toLowerCase();

  if (status === 429 || parsed.providerErrorType === "rate_limit_error") {
    return new KieProviderError(
      PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMIT,
      "Провайдер временно ограничил запросы. Попробуйте позже.",
      status,
    );
  }
  if (
    status === 404 ||
    lower.includes("model not found") ||
    lower.includes("unavailable") ||
    parsed.providerErrorType === "not_found_error"
  ) {
    return new KieProviderError(
      PROVIDER_ERROR_CODES.MODEL_UNAVAILABLE,
      "Модель временно недоступна.",
      status,
    );
  }
  if (lower.includes("not supported") || lower.includes("unsupported")) {
    return new KieProviderError(
      PROVIDER_ERROR_CODES.MODEL_NOT_SUPPORTED,
      "Операция не поддерживается выбранной моделью.",
      status,
    );
  }
  return new KieProviderError(
    PROVIDER_ERROR_CODES.PROVIDER_ERROR,
    "Ошибка провайдера. Попробуйте позже.",
    status,
  );
}

export function userFacingProviderMessage(code: string): string {
  switch (code) {
    case PROVIDER_ERROR_CODES.MODEL_UNAVAILABLE:
      return "Модель временно недоступна.";
    case PROVIDER_ERROR_CODES.MODEL_NOT_SUPPORTED:
      return "Операция не поддерживается выбранной моделью.";
    case PROVIDER_ERROR_CODES.MODEL_CAPABILITY_MISMATCH:
      return "Выбранная модель не поддерживает нужный режим.";
    case PROVIDER_ERROR_CODES.INVALID_REASONING_LEVEL:
      return "Некорректный уровень reasoning для этой модели.";
    case PROVIDER_ERROR_CODES.INVALID_QUALITY_LEVEL:
      return "Некорректный уровень качества для этой модели.";
    case PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMIT:
      return "Провайдер временно ограничил запросы.";
    default:
      return "Ошибка провайдера.";
  }
}
