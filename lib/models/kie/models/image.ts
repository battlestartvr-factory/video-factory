import type { KieModelEntry } from "../types";

/**
 * Approved production image surface.
 *
 * Keep this list intentionally small: every enabled entry must have a real generator UI
 * path and a durable provider execution path. Nano Banana 2 Lite and the older exploratory
 * image models are deliberately not exposed here.
 */
export const IMAGE_MODELS: KieModelEntry[] = [
  {
    id: "gpt-image-2",
    displayName: "GPT Image 2",
    provider: "kie",
    category: "image",
    adapter: "market_task",
    endpoint: "/api/v1/jobs/createTask",
    providerModel: "gpt-image-2",
    capabilities: {
      imageGeneration: true,
      textToImage: true,
      imageToImage: true,
      imageEdit: true,
      referenceImages: true,
      aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
      maxReferenceImages: 4,
    },
    quality: {
      levels: ["low", "medium", "high"],
      default: "medium",
      mapping: { low: "1K", medium: "2K", high: "4K" },
    },
    defaults: { isDefault: true },
    enabled: true,
    useCases: ["text-to-image", "image-to-image", "image editing", "general purpose"],
  },
  {
    id: "nano-banana-2",
    displayName: "Nano Banana 2",
    provider: "kie",
    category: "image",
    adapter: "market_task",
    endpoint: "/api/v1/jobs/createTask",
    providerModel: "nano-banana-2",
    capabilities: {
      imageGeneration: true,
      textToImage: true,
      imageToImage: true,
      imageEdit: true,
      referenceImages: true,
      aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
      maxReferenceImages: 8,
    },
    quality: {
      levels: ["low", "medium", "high"],
      default: "medium",
      mapping: { low: "1K", medium: "2K", high: "4K" },
    },
    enabled: true,
    useCases: ["reference workflows", "image editing", "fast visual iterations"],
  },
  {
    id: "nano-banana-pro",
    displayName: "Nano Banana Pro",
    provider: "kie",
    category: "image",
    adapter: "market_task",
    endpoint: "/api/v1/jobs/createTask",
    providerModel: "nano-banana-pro",
    capabilities: {
      imageGeneration: true,
      textToImage: true,
      imageToImage: true,
      imageEdit: true,
      referenceImages: true,
      aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
      maxReferenceImages: 4,
    },
    quality: {
      levels: ["low", "medium", "high"],
      default: "medium",
      mapping: { low: "1K", medium: "2K", high: "4K" },
    },
    enabled: true,
    useCases: ["premium image generation", "reference workflows", "image editing"],
  },
];
