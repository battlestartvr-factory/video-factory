import type { AIModel } from "@/lib/types/workspace";

/**
 * Model registry — data-driven, extensible without frontend changes.
 * Future: load from provider_models table via API.
 */
export const MODEL_REGISTRY: AIModel[] = [
  {
    id: "gemini-3-flash",
    provider: "kie",
    name: "Gemini 3 Flash",
    type: "chat",
    capabilities: {
      chat: true,
      vision: true,
    },
  },
  {
    id: "nano-banana-2-lite",
    provider: "kie",
    name: "Nano Banana 2 Lite",
    type: "image",
    capabilities: {
      imageGeneration: true,
      referenceImages: true,
      aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
      resolutions: ["512", "1024", "2048"],
    },
  },
  {
    id: "bytedance-v1-lite-i2v",
    provider: "kie",
    name: "ByteDance V1 Lite I2V",
    type: "video",
    capabilities: {
      videoGeneration: true,
      startFrame: true,
      referenceImages: true,
      aspectRatios: ["16:9", "9:16", "1:1"],
      resolutions: ["720p", "1080p"],
      durations: [5, 10],
    },
  },
  {
    id: "kling-3",
    provider: "kling",
    name: "Kling 3",
    type: "video",
    capabilities: {
      videoGeneration: true,
      startFrame: true,
      endFrame: true,
      referenceImages: true,
      referenceVideo: true,
      audio: true,
      aspectRatios: ["16:9", "9:16", "1:1"],
      resolutions: ["720p", "1080p"],
      durations: [5, 10, 15],
    },
  },
  {
    id: "flux-pro",
    provider: "fal",
    name: "Flux Pro",
    type: "image",
    capabilities: {
      imageGeneration: true,
      referenceImages: true,
      aspectRatios: ["1:1", "16:9", "9:16", "4:3"],
      resolutions: ["1024", "2048"],
    },
  },
];

export function getModelById(id: string): AIModel | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}

export function getModelsByType(type: AIModel["type"]): AIModel[] {
  return MODEL_REGISTRY.filter((m) => m.type === type);
}

export function getChatModels(): AIModel[] {
  return MODEL_REGISTRY.filter((m) => m.capabilities.chat);
}

export function getImageModels(): AIModel[] {
  return MODEL_REGISTRY.filter((m) => m.capabilities.imageGeneration);
}

export function getVideoModels(): AIModel[] {
  return MODEL_REGISTRY.filter((m) => m.capabilities.videoGeneration);
}

export function modelSupports(modelId: string, capability: keyof AIModel["capabilities"]): boolean {
  const model = getModelById(modelId);
  if (!model) return false;
  const val = model.capabilities[capability];
  if (typeof val === "boolean") return val;
  if (Array.isArray(val)) return val.length > 0;
  return false;
}
