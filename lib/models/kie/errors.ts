import { PROVIDER_ERROR_CODES } from "./types";

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

export function normalizeKieError(status: number, body?: string): KieProviderError {
  const lower = (body ?? "").toLowerCase();
  if (status === 429) {
    return new KieProviderError(
      PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMIT,
      "Провайдер временно ограничил запросы. Попробуйте позже.",
      status,
    );
  }
  if (status === 404 || lower.includes("model not found") || lower.includes("unavailable")) {
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
