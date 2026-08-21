export interface ResearchUserFacingFailure {
  code: string | null;
  message: string;
}

const FRIENDLY_RESEARCH_ERRORS: Record<string, string> = {
  RESEARCH_SYNTHESIS_FAILED:
    "Не удалось собрать корректный Evidence Pack из найденных данных. Исследование остановлено, а технические детали сохранены в диагностике запуска.",
  RESEARCH_COVERAGE_LOW:
    "Исследование не набрало достаточного подтверждённого покрытия, поэтому завод не стал строить концепты на слабых данных.",
  RESEARCH_SCOUT_COVERAGE_FAILED:
    "Недостаточно Research Scouts завершили анализ, чтобы безопасно продолжить к синтезу и концептам.",
  RESEARCH_SCOUT_ROLE_ANALYSIS_INSUFFICIENT:
    "Один из Research Scouts не смог извлечь достаточно качественных подтверждённых сигналов из найденных источников.",
  WEB_SEARCH_GROUNDING_MISSING:
    "Поиск не вернул проверяемые ссылки на источники, поэтому исследование остановлено вместо использования неподтверждённых данных.",
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function looksLikeTechnicalDump(message: string): boolean {
  if (message.length > 240) return true;
  if ((message.match(/\n/g) ?? []).length > 2) return true;
  if (/^[\[{]/.test(message.trim())) return true;
  return /(?:zod|invalid_type|too_big|too_small|expected\s|received\s|"path"\s*:|"issues"\s*:)/i.test(message);
}

export function researchUserFacingFailure(error: unknown): ResearchUserFacingFailure {
  const row = object(error);
  const code = stringValue(row.code);
  if (code && FRIENDLY_RESEARCH_ERRORS[code]) {
    return { code, message: FRIENDLY_RESEARCH_ERRORS[code]! };
  }

  const rawMessage = stringValue(row.message) ?? (error instanceof Error ? stringValue(error.message) : null);
  if (rawMessage && !looksLikeTechnicalDump(rawMessage)) {
    return { code, message: rawMessage };
  }

  return {
    code,
    message:
      "Исследование остановлено из-за технической ошибки. Подробная диагностика сохранена внутри запуска и не выводится в чат целиком.",
  };
}
