import { LLM_MODELS } from "./models/llm";
import { IMAGE_MODELS } from "./models/image";
import { VIDEO_MODELS } from "./models/video";
import type {
  KieModelEntry,
  ModelCategory,
  PublicModelMetadata,
  ReasoningLevel,
} from "./types";

export const KIE_MODEL_REGISTRY: KieModelEntry[] = [
  ...LLM_MODELS,
  ...IMAGE_MODELS,
  ...VIDEO_MODELS,
];

const aliasIndex = new Map<string, string>();
for (const model of KIE_MODEL_REGISTRY) {
  for (const alias of model.aliases ?? []) {
    aliasIndex.set(alias, model.id);
  }
}

export function resolveModelId(id: string): string {
  return aliasIndex.get(id) ?? id;
}

export function getKieModelById(id: string): KieModelEntry | undefined {
  const resolved = resolveModelId(id);
  return KIE_MODEL_REGISTRY.find((m) => m.id === resolved && m.enabled);
}

export function getKieModelsByCategory(category: ModelCategory): KieModelEntry[] {
  return KIE_MODEL_REGISTRY.filter((m) => m.category === category && m.enabled);
}

export function getDefaultLlmModel(): KieModelEntry {
  return (
    KIE_MODEL_REGISTRY.find((m) => m.category === "llm" && m.defaults?.isDefault && m.enabled) ??
    LLM_MODELS[0]!
  );
}

export function getDefaultImageModel(): KieModelEntry {
  return (
    KIE_MODEL_REGISTRY.find((m) => m.category === "image" && m.defaults?.isDefault && m.enabled) ??
    IMAGE_MODELS[0]!
  );
}

export function getDefaultVideoModel(): KieModelEntry {
  return (
    KIE_MODEL_REGISTRY.find((m) => m.category === "video" && m.defaults?.isDefault && m.enabled) ??
    VIDEO_MODELS[0]!
  );
}

export function toPublicMetadata(model: KieModelEntry): PublicModelMetadata {
  return {
    id: model.id,
    displayName: model.displayName,
    category: model.category,
    capabilities: model.capabilities,
    reasoning: model.reasoning
      ? {
          control: model.reasoning.control,
          levels: model.reasoning.levels,
          default: model.reasoning.default,
        }
      : undefined,
    quality: model.quality
      ? {
          levels: model.quality.levels,
          default: model.quality.default,
        }
      : undefined,
    defaults: model.defaults,
    enabled: model.enabled,
  };
}

export function getPublicModels(category?: ModelCategory): PublicModelMetadata[] {
  const models = category
    ? getKieModelsByCategory(category)
    : KIE_MODEL_REGISTRY.filter((m) => m.enabled);
  return models.map(toPublicMetadata);
}

export function modelHasCapability(
  modelId: string,
  capability: keyof KieModelEntry["capabilities"],
): boolean {
  const model = getKieModelById(modelId);
  if (!model) return false;
  const val = model.capabilities[capability];
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val > 0;
  if (Array.isArray(val)) return val.length > 0;
  return false;
}

export function resolveLlmModel(requested?: string | null): {
  model: KieModelEntry;
  allowed: boolean;
} {
  const defaultModel = getDefaultLlmModel();
  if (!requested?.trim()) {
    return { model: defaultModel, allowed: true };
  }
  const resolved = resolveModelId(requested.trim());
  const model = getKieModelById(resolved);
  if (model?.category === "llm") {
    return { model, allowed: true };
  }
  // Backward compat: allow env override model strings not in registry
  const fallback = getKieModelById(resolveModelId(defaultModel.id));
  return { model: fallback ?? defaultModel, allowed: false };
}

export function getChatReasoningFromMetadata(
  metadata: Record<string, unknown>,
  presetSettings?: Record<string, unknown>,
): ReasoningLevel | "off" | "on" | undefined {
  const fromMeta = metadata.reasoning_level ?? metadata.reasoningLevel;
  if (typeof fromMeta === "string") return fromMeta as ReasoningLevel | "off" | "on";
  const fromPreset = presetSettings?.reasoning_level ?? presetSettings?.reasoningLevel;
  if (typeof fromPreset === "string") return fromPreset as ReasoningLevel | "off" | "on";
  return undefined;
}

export {
  LLM_MODELS,
  IMAGE_MODELS,
  VIDEO_MODELS,
};
