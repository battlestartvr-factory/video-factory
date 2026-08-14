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

export type KieResponseParseStage =
  | "json"
  | "sse_assembled"
  | "empty_body"
  | "json_parse_failed"
  | "extract_message"
  | "error_body";

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
  content_type?: string;
  http_error_category: KieHttpErrorCategory;
  normalized_error_code: string;
  response_parse_stage?: KieResponseParseStage;
  agent_run_id?: string;
  provider_error_code?: string;
  provider_error_type?: string;
  request_id?: string;
}

export function logKieProviderError(diagnostics: KieProviderDiagnostics): void {
  kieLogger.error("kie_provider_request_failed", {
    request_id: diagnostics.request_id,
    agent_run_id: diagnostics.agent_run_id,
    model_id: diagnostics.model_id,
    adapter: diagnostics.adapter,
    endpoint: diagnostics.endpoint,
    http_status: diagnostics.http_status,
    content_type: diagnostics.content_type,
    http_error_category: diagnostics.http_error_category,
    normalized_error_code: diagnostics.normalized_error_code,
    provider_error_code: diagnostics.provider_error_code,
    provider_error_type: diagnostics.provider_error_type,
    response_parse_stage: diagnostics.response_parse_stage,
  });
}

function classifyErrorCategory(
  status: number,
  contentType: string,
  parsed: ReturnType<typeof parseKieErrorBody>,
  lower: string,
): string {
  if (status === 401 || status === 403 || parsed.providerErrorType === "authentication_error") {
    return "AUTHENTICATION_ERROR";
  }
  if (status === 404 || lower.includes("not found")) return "WRONG_ENDPOINT";
  if (status === 400 || status === 422 || parsed.providerErrorType === "invalid_request_error") {
    return "INVALID_PROVIDER_REQUEST";
  }
  if (contentType.includes("text/event-stream") && status >= 400) {
    return "UNSUPPORTED_RESPONSE_FORMAT";
  }
  if (status === 429 || parsed.providerErrorType === "rate_limit_error") return "RATE_LIMIT";
  return "PROVIDER_FAILURE";
}

export function normalizeKieError(
  status: number,
  body?: string,
  contentType = "",
): KieProviderError {
  const parsed = parseKieErrorBody(body);
  const lower = (body ?? "").toLowerCase();
  const category = classifyErrorCategory(status, contentType, parsed, lower);

  if (category === "RATE_LIMIT") {
    return new KieProviderError(
      PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMIT,
      "Провайдер временно ограничил запросы. Попробуйте позже.",
      status,
    );
  }
  if (category === "WRONG_ENDPOINT" || lower.includes("unavailable")) {
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
  if (category === "AUTHENTICATION_ERROR") {
    return new KieProviderError(
      PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      "Ошибка провайдера. Попробуйте позже.",
      status,
    );
  }
  if (category === "INVALID_PROVIDER_REQUEST") {
    return new KieProviderError(
      PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      "Ошибка провайдера. Попробуйте позже.",
      status,
    );
  }
  if (category === "UNSUPPORTED_RESPONSE_FORMAT" || category === "RESPONSE_PARSE_ERROR") {
    return new KieProviderError(
      PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      "Ошибка провайдера. Попробуйте позже.",
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
