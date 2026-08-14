import { PROVIDER_ERROR_CODES } from "./types";
import type { KieModelEntry, ReasoningLevel, ResolvedReasoning } from "./types";
import { KieProviderError } from "./errors";

const DEFAULT_REASONING: ReasoningLevel = "medium";

export function resolveReasoning(
  model: KieModelEntry,
  requested?: ReasoningLevel | "off" | "on" | "standard" | "thinking" | null,
): ResolvedReasoning {
  const config = model.reasoning;
  if (!config || config.control === "none") {
    return {
      requestedReasoning: requested ?? DEFAULT_REASONING,
      effectiveReasoning: "none",
      providerParam: {},
    };
  }

  const level = requested ?? (config.default as ReasoningLevel | "off" | "on") ?? DEFAULT_REASONING;

  if (config.control === "binary") {
    const binaryLevel =
      level === "on" || level === "thinking" || level === "high" || level === "max"
        ? "thinking"
        : "standard";
    const normalizedLevel =
      level === "off" ? "standard" : level === "on" ? "thinking" : binaryLevel;
    if (!config.levels.includes(normalizedLevel as ReasoningLevel | "off" | "on")) {
      throw new KieProviderError(
        PROVIDER_ERROR_CODES.INVALID_REASONING_LEVEL,
        `Reasoning level "${level}" not supported by ${model.displayName}`,
      );
    }
    const effective = config.mapping[normalizedLevel] ?? normalizedLevel;
    return {
      requestedReasoning: normalizedLevel as ReasoningLevel | "off" | "on",
      effectiveReasoning: effective,
      providerParam: buildReasoningParam(model, effective),
    };
  }

  const appLevel = normalizeToAppLevel(level, config.levels as ReasoningLevel[]);
  if (!config.levels.includes(appLevel as ReasoningLevel | "off" | "on")) {
    throw new KieProviderError(
      PROVIDER_ERROR_CODES.INVALID_REASONING_LEVEL,
      `Reasoning level "${level}" not supported by ${model.displayName}`,
    );
  }

  const effective = config.mapping[appLevel] ?? appLevel;
  return {
    requestedReasoning: appLevel,
    effectiveReasoning: effective,
    providerParam: buildReasoningParam(model, effective),
  };
}

function normalizeToAppLevel(
  level: ReasoningLevel | "off" | "on" | "standard" | "thinking",
  supported: ReasoningLevel[],
): ReasoningLevel {
  if (supported.includes(level as ReasoningLevel)) return level as ReasoningLevel;
  // Map "max" to highest supported level when model lacks native max
  if (level === "max" && supported.length) {
    const order: ReasoningLevel[] = ["low", "medium", "high", "max"];
    const supportedSet = new Set(supported);
    for (let i = order.length - 1; i >= 0; i--) {
      if (supportedSet.has(order[i]!)) return order[i]!;
    }
  }
  return DEFAULT_REASONING;
}

function buildReasoningParam(model: KieModelEntry, effective: string): Record<string, unknown> {
  if (model.adapter === "responses") {
    return { reasoning: { effort: effective } };
  }

  if (model.adapter === "claude_sonnet") {
    if (effective === "enabled" || effective === "thinking" || effective === "on") {
      return { thinkingFlag: true };
    }
    return {};
  }

  const control = model.reasoning?.control;
  switch (control) {
    case "effort":
      return { reasoning_effort: effective };
    case "adaptive":
      return { thinking: { type: effective } };
    case "binary":
      return effective === "enabled" || effective === "on"
        ? { thinking: { type: "enabled" } }
        : { thinking: { type: "disabled" } };
    default:
      return {};
  }
}

export function getDefaultReasoningLevel(
  model: KieModelEntry,
): ReasoningLevel | "off" | "on" | "standard" | "thinking" {
  return (model.reasoning?.default as ReasoningLevel | "off" | "on" | "standard" | "thinking") ?? DEFAULT_REASONING;
}
