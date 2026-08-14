export type ProductionIntent = "generate" | "assemble_edit" | "hybrid" | "ambiguous";

export interface IntentAnalysis {
  intent: ProductionIntent;
  mediaIntent?: "generate_video" | "edit_video" | "assemble_short" | "generate_image";
  needsClarification: boolean;
}

const GENERATE_PATTERNS = [
  /сгенерир/i,
  /генерир/i,
  /создай\s+(?:видео|ролик|клип)/i,
  /generate\s+video/i,
  /text-to-video/i,
  /image-to-video/i,
  /в\s+kling/i,
  /в\s+veo/i,
  /из\s+этой\s+картин/i,
];

const ASSEMBLE_PATTERNS = [
  /смонтир/i,
  /монтаж/i,
  /собери\s+(?:shorts|reels|ролик|видео)/i,
  /из\s+(?:этих|них)\s+\d*\s*видео/i,
  /возьми\s+(?:эти|эти\s+\d+)\s+видео/i,
  /assemble/i,
  /edit\s+(?:from|these)/i,
];

const AMBIGUOUS_PATTERNS = [
  /сделай\s+шортс/i,
  /сделай\s+reels/i,
  /сделай\s+ролик/i,
  /сделай\s+реклам/i,
  /смонтируй\s+ролик/i,
  /сделай\s+видео/i,
];

const HYBRID_PATTERNS = [
  /гибрид/i,
  /монтаж\s*\+\s*генерац/i,
  /сгенерир.*смонтир/i,
  /смонтир.*сгенерир/i,
];

export function analyzeProductionIntent(message: string): IntentAnalysis {
  const text = message.trim();
  if (!text) return { intent: "ambiguous", needsClarification: false };

  if (HYBRID_PATTERNS.some((p) => p.test(text))) {
    return {
      intent: "hybrid",
      mediaIntent: "generate_video",
      needsClarification: false,
    };
  }

  if (GENERATE_PATTERNS.some((p) => p.test(text))) {
    return {
      intent: "generate",
      mediaIntent: "generate_video",
      needsClarification: false,
    };
  }

  if (ASSEMBLE_PATTERNS.some((p) => p.test(text))) {
    return {
      intent: "assemble_edit",
      mediaIntent: "assemble_short",
      needsClarification: false,
    };
  }

  if (AMBIGUOUS_PATTERNS.some((p) => p.test(text))) {
    return {
      intent: "ambiguous",
      needsClarification: true,
    };
  }

  return { intent: "generate", needsClarification: false };
}

export const PRODUCTION_INTENT_CLARIFICATION =
  "Что делаем?\n\n1. Генерируем новые видеосцены\n2. Монтируем/редактируем ролик из имеющихся материалов\n3. Делаем гибрид: монтаж + AI-генерация новых сцен";

export function mapIntentToActionType(intent: ProductionIntent): string {
  switch (intent) {
    case "generate":
      return "generate_video";
    case "assemble_edit":
      return "assemble_short";
    case "hybrid":
      return "generate_video";
    default:
      return "pending_dispatch";
  }
}
