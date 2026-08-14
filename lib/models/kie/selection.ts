import type { KieModelEntry, MediaQuality, SelectionSource } from "./types";
import {
  getDefaultImageModel,
  getDefaultVideoModel,
  getKieModelById,
  getKieModelsByCategory,
} from "./registry";

export interface MediaSelectionCriteria {
  mode?: string;
  referenceCount?: number;
  needsTypography?: boolean;
  needsHighQuality?: boolean;
  needsFast?: boolean;
  needsVideoEdit?: boolean;
  needsMultiShot?: boolean;
  needsEndFrame?: boolean;
  needsSound?: boolean;
  needsMultiReference?: boolean;
  explicitModelId?: string | null;
  uiModelId?: string | null;
  presetModelId?: string | null;
}

export interface MediaSelectionResult {
  model: KieModelEntry;
  selectionSource: SelectionSource;
  quality: MediaQuality;
}

const AUTO_IMAGE_ID = "auto";
const AUTO_VIDEO_ID = "auto";

export function isAutoModel(modelId?: string | null): boolean {
  return !modelId || modelId === AUTO_IMAGE_ID || modelId === AUTO_VIDEO_ID;
}

export function selectImageModel(criteria: MediaSelectionCriteria): MediaSelectionResult {
  const priority = [
    { id: criteria.explicitModelId, source: "user" as SelectionSource },
    { id: criteria.uiModelId, source: "ui" as SelectionSource },
    { id: criteria.presetModelId, source: "preset" as SelectionSource },
  ];

  for (const { id, source } of priority) {
    if (id && !isAutoModel(id)) {
      const model = getKieModelById(id);
      if (model?.category === "image") {
        return { model, selectionSource: source, quality: scoreQuality(criteria) };
      }
    }
  }

  const candidates = getKieModelsByCategory("image");
  const selected = pickBestImageModel(candidates, criteria);
  return {
    model: selected,
    selectionSource: "agent",
    quality: scoreQuality(criteria),
  };
}

export function selectVideoModel(criteria: MediaSelectionCriteria): MediaSelectionResult {
  const priority = [
    { id: criteria.explicitModelId, source: "user" as SelectionSource },
    { id: criteria.uiModelId, source: "ui" as SelectionSource },
    { id: criteria.presetModelId, source: "preset" as SelectionSource },
  ];

  for (const { id, source } of priority) {
    if (id && !isAutoModel(id)) {
      const model = getKieModelById(id);
      if (model?.category === "video") {
        return { model, selectionSource: source, quality: scoreQuality(criteria) };
      }
    }
  }

  const candidates = getKieModelsByCategory("video");
  const selected = pickBestVideoModel(candidates, criteria);
  return {
    model: selected,
    selectionSource: "agent",
    quality: scoreQuality(criteria),
  };
}

function scoreQuality(criteria: MediaSelectionCriteria): MediaQuality {
  if (criteria.needsHighQuality) return "high";
  if (criteria.needsFast) return "low";
  return "medium";
}

function pickBestImageModel(candidates: KieModelEntry[], criteria: MediaSelectionCriteria): KieModelEntry {
  const defaultModel = getDefaultImageModel();
  let best = defaultModel;
  let bestScore = -1;

  for (const model of candidates) {
    let score = 0;
    const caps = model.capabilities;

    if (criteria.mode === "image-edit" && caps.imageEdit) score += 10;
    if (criteria.mode === "reference-images" && caps.referenceImages) score += 8;
    if (criteria.needsTypography && caps.typography) score += 15;
    if (criteria.needsMultiReference && caps.multiReference) score += 12;
    if (criteria.needsHighQuality && caps.highResolution) score += 8;
    if ((criteria.referenceCount ?? 0) > 1 && (caps.maxReferenceImages ?? 0) >= (criteria.referenceCount ?? 0)) {
      score += 6;
    }
    if (criteria.needsFast && model.id === "nano-banana-2") score += 5;
    if (model.defaults?.isDefault) score += 2;

    if (score > bestScore) {
      bestScore = score;
      best = model;
    }
  }

  return best;
}

function pickBestVideoModel(candidates: KieModelEntry[], criteria: MediaSelectionCriteria): KieModelEntry {
  const defaultModel = getDefaultVideoModel();
  let best = defaultModel;
  let bestScore = -1;

  for (const model of candidates) {
    let score = 0;
    const caps = model.capabilities;

    if (criteria.needsEndFrame && caps.endFrame) score += 12;
    if (criteria.needsMultiShot && caps.multiShot) score += 10;
    if (criteria.needsSound && (caps.sound || caps.audio)) score += 8;
    if (criteria.needsVideoEdit && caps.videoEdit) score += 15;
    if (criteria.mode === "reference-to-video" && caps.referenceToVideo) score += 10;
    if (criteria.needsHighQuality && model.id === "veo-3-1") score += 6;
    if (criteria.needsFast && model.id === "seedance-2-5") score += 5;
    if (model.defaults?.isDefault) score += 2;

    if (score > bestScore) {
      bestScore = score;
      best = model;
    }
  }

  return best;
}

export function checkModelCapabilityMismatch(
  modelId: string,
  requiredCapabilities: (keyof KieModelEntry["capabilities"])[],
): string[] {
  const model = getKieModelById(modelId);
  if (!model) return ["MODEL_NOT_SUPPORTED"];
  const missing: string[] = [];
  for (const cap of requiredCapabilities) {
    const val = model.capabilities[cap];
    if (!val) missing.push(cap);
  }
  return missing;
}

export function suggestAlternativeModel(
  category: "image" | "video",
  requiredCapabilities: (keyof KieModelEntry["capabilities"])[],
): KieModelEntry | undefined {
  const candidates = getKieModelsByCategory(category);
  return candidates.find((model) =>
    requiredCapabilities.every((cap) => Boolean(model.capabilities[cap])),
  );
}
