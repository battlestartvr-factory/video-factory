import "server-only";

import { callKieGeminiJson } from "@/lib/models/kie/gemini-json";

export type HumanFeedbackLocale = "ru" | "en" | "unknown";

export interface CanonicalHumanFeedback {
  originalLocale: HumanFeedbackLocale;
  originalText: string;
  canonicalEnglish: string;
  translated: boolean;
  translationModel: string | null;
  translationUsage: Record<string, unknown>;
  translationFallback: boolean;
}

export function detectHumanFeedbackLocale(value: string): HumanFeedbackLocale {
  const text = value.trim();
  if (!text) return "unknown";
  if (/[А-Яа-яЁё]/u.test(text)) return "ru";
  if (/[A-Za-z]/u.test(text)) return "en";
  return "unknown";
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function canonicalizeHumanFeedback(value: string): Promise<CanonicalHumanFeedback> {
  const originalText = value.trim();
  const originalLocale = detectHumanFeedbackLocale(originalText);
  if (!originalText || originalLocale !== "ru") {
    return {
      originalLocale,
      originalText,
      canonicalEnglish: originalText,
      translated: false,
      translationModel: null,
      translationUsage: {},
      translationFallback: false,
    };
  }

  try {
    const result = await callKieGeminiJson({
      model: (process.env.KIE_FEEDBACK_TRANSLATION_MODEL ?? "").trim() || "gemini-3-6-flash",
      temperature: 0.05,
      prompt: [
        "Translate the Russian human feedback below into faithful concise English for internal AI agents.",
        "Preserve every concrete request, criticism, preference, negation, game-design term and intensity. Do not summarize away details and do not add advice.",
        "Return JSON only: {\"english\":\"...\"}.",
        `RUSSIAN_FEEDBACK=${JSON.stringify(originalText)}`,
      ].join("\n"),
    });
    const english = object(result.value).english;
    if (typeof english !== "string" || !english.trim()) throw new Error("EMPTY_TRANSLATION");
    return {
      originalLocale,
      originalText,
      canonicalEnglish: english.trim(),
      translated: true,
      translationModel: result.model,
      translationUsage: result.usage,
      translationFallback: false,
    };
  } catch {
    // Human decisions must never be lost because a translation helper is temporarily unavailable.
    // Downstream LLMs can still understand the preserved original Russian text.
    return {
      originalLocale,
      originalText,
      canonicalEnglish: originalText,
      translated: false,
      translationModel: null,
      translationUsage: {},
      translationFallback: true,
    };
  }
}
