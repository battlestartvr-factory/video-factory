import type { AIModel, ModelCapabilities } from "@/lib/types/workspace";
import {
  KIE_MODEL_REGISTRY,
  getKieModelById,
  getKieModelsByCategory,
  getDefaultLlmModel,
  getDefaultImageModel,
  getDefaultVideoModel,
  modelHasCapability,
  resolveModelId,
} from "./kie/registry";

/**
 * Backward-compatible AIModel view over the KIE Model Registry.
 * Source of truth: lib/models/kie/registry.ts
 */
function toAIModel(entry: ReturnType<typeof getKieModelById>): AIModel | null {
  if (!entry) return null;
  const caps: ModelCapabilities = {
    chat: entry.capabilities.chat,
    vision: entry.capabilities.vision,
    toolCalling: entry.capabilities.toolCalling,
    imageGeneration: entry.capabilities.imageGeneration,
    videoGeneration: entry.capabilities.videoGeneration,
    startFrame: entry.capabilities.startFrame,
    endFrame: entry.capabilities.endFrame,
    referenceImages: entry.capabilities.referenceImages,
    referenceVideo: entry.capabilities.referenceVideo,
    audio: entry.capabilities.audio ?? entry.capabilities.sound,
    aspectRatios: entry.capabilities.aspectRatios,
    resolutions: entry.capabilities.resolutions,
    durations: entry.capabilities.durations,
  };
  return {
    id: entry.id,
    provider: entry.provider,
    name: entry.displayName,
    type:
      entry.category === "llm" ? "chat" : entry.category === "image" ? "image" : "video",
    capabilities: caps,
  };
}

export const MODEL_REGISTRY: AIModel[] = KIE_MODEL_REGISTRY.filter((m) => m.enabled).map(
  (entry) => toAIModel(entry)!,
);

export function getModelById(id: string): AIModel | undefined {
  const resolved = resolveModelId(id);
  return toAIModel(getKieModelById(resolved)) ?? undefined;
}

export function getModelsByType(type: AIModel["type"]): AIModel[] {
  const category = type === "chat" ? "llm" : type;
  return getKieModelsByCategory(category as "llm" | "image" | "video")
    .map((entry) => toAIModel(entry)!)
    .filter(Boolean);
}

export function getChatModels(): AIModel[] {
  return getModelsByType("chat");
}

export function getImageModels(): AIModel[] {
  return getModelsByType("image");
}

export function getVideoModels(): AIModel[] {
  return getModelsByType("video");
}

export function modelSupports(modelId: string, capability: keyof ModelCapabilities): boolean {
  return modelHasCapability(resolveModelId(modelId), capability as never);
}

export {
  getDefaultLlmModel,
  getDefaultImageModel,
  getDefaultVideoModel,
  resolveModelId,
};
