import { PROVIDER_ERROR_CODES } from "./types";
import type { KieModelEntry, MediaQuality, ResolvedQuality } from "./types";
import { KieProviderError } from "./errors";

const DEFAULT_QUALITY: MediaQuality = "medium";

export function resolveQuality(
  model: KieModelEntry,
  requested?: MediaQuality | null,
): ResolvedQuality {
  const config = model.quality;
  if (!config) {
    return {
      requestedQuality: requested ?? DEFAULT_QUALITY,
      effectiveQuality: "default",
      providerParam: {},
    };
  }

  const level = requested ?? config.default ?? DEFAULT_QUALITY;
  if (!config.levels.includes(level)) {
    throw new KieProviderError(
      PROVIDER_ERROR_CODES.INVALID_QUALITY_LEVEL,
      `Quality level "${level}" not supported by ${model.displayName}`,
    );
  }

  const effective = config.mapping[level];
  return {
    requestedQuality: level,
    effectiveQuality: effective,
    providerParam: buildQualityParam(model, effective),
  };
}

function buildQualityParam(model: KieModelEntry, effective: string): Record<string, unknown> {
  if (model.adapter === "veo") {
    return { variant: effective };
  }
  if (model.id === "kling-3") {
    return { mode: effective };
  }
  // Resolution-style mapping (1K/2K/4K)
  if (["1K", "2K", "4K"].includes(effective)) {
    return { resolution: effective };
  }
  return { quality: effective };
}

export function getDefaultQualityLevel(model: KieModelEntry): MediaQuality {
  return model.quality?.default ?? DEFAULT_QUALITY;
}
