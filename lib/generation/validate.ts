import {
  getKieModelById,
  getDefaultImageModel,
  getDefaultVideoModel,
  resolveModelId,
  resolveQuality,
  selectImageModel,
  selectVideoModel,
  checkModelCapabilityMismatch,
  suggestAlternativeModel,
} from "@/lib/models/kie";
import type { MediaQuality, SelectionSource } from "@/lib/models/kie/types";
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, CONTENT_LIMITS } from "@/lib/agent/config";
import type { KieModelEntry } from "@/lib/models/kie/types";

export class GenerationValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GenerationValidationError";
  }
}

export interface ValidatedImageRequest {
  model: KieModelEntry;
  mode: string;
  settings: {
    aspectRatio?: string;
    resolution?: string;
    numOutputs: number;
    quality?: MediaQuality;
    effectiveQuality?: string;
    selectionSource?: SelectionSource;
  };
}

export interface ValidatedVideoRequest {
  model: KieModelEntry;
  mode: string;
  settings: {
    aspectRatio?: string;
    resolution?: string;
    durationSec?: number;
    numOutputs: number;
    startFrameAssetId?: string;
    endFrameAssetId?: string;
    quality?: MediaQuality;
    effectiveQuality?: string;
    selectionSource?: SelectionSource;
  };
}

export function resolveImageModel(modelId?: string): KieModelEntry {
  if (modelId && modelId !== "auto") {
    const model = getKieModelById(resolveModelId(modelId));
    if (model?.capabilities.imageGeneration) return model;
    throw new GenerationValidationError(
      "MODEL_CAPABILITY_MISSING",
      "Модель не поддерживает генерацию изображений",
    );
  }
  return getDefaultImageModel();
}

export function resolveVideoModel(modelId?: string): KieModelEntry {
  if (modelId && modelId !== "auto") {
    const model = getKieModelById(resolveModelId(modelId));
    if (model?.capabilities.videoGeneration) return model;
    throw new GenerationValidationError(
      "MODEL_CAPABILITY_MISSING",
      "Модель не поддерживает генерацию видео",
    );
  }
  return getDefaultVideoModel();
}

export function inferImageMode(inputAssetIds: string[], requested?: string): string {
  if (requested) return requested;
  return inputAssetIds.length > 0 ? "image-to-image" : "text-to-image";
}

export function inferVideoMode(input: {
  startFrameAssetId?: string;
  endFrameAssetId?: string;
  inputAssetIds: string[];
  requested?: string;
}): string {
  if (input.requested) return input.requested;
  if (input.startFrameAssetId && input.endFrameAssetId) return "start-end-frames";
  if (input.startFrameAssetId || input.inputAssetIds.length > 0) return "image-to-video";
  return "text-to-video";
}

function requiredCapabilitiesForVideoMode(mode: string): (keyof KieModelEntry["capabilities"])[] {
  switch (mode) {
    case "start-end-frames":
      return ["endFrame", "startFrame"];
    case "image-to-video":
      return ["imageToVideo"];
    case "reference-to-video":
      return ["referenceToVideo"];
    default:
      return ["textToVideo"];
  }
}

export function validateImageGenerationRequest(input: {
  modelId?: string;
  inputAssetIds?: string[];
  aspectRatio?: string;
  resolution?: string;
  quality?: MediaQuality;
  outputs?: number;
  mode?: string;
  selectionSource?: SelectionSource;
}): ValidatedImageRequest {
  const inputAssetIds = input.inputAssetIds ?? [];
  const mode = inferImageMode(inputAssetIds, input.mode);

  const selection = selectImageModel({
    explicitModelId: input.selectionSource === "user" ? input.modelId : undefined,
    uiModelId: input.selectionSource === "ui" ? input.modelId : input.modelId,
    mode,
    referenceCount: inputAssetIds.length,
    needsTypography: mode === "text-to-image",
  });

  const model = input.modelId && input.modelId !== "auto"
    ? resolveImageModel(input.modelId)
    : selection.model;

  const numOutputs = Math.min(
    Math.max(input.outputs ?? 1, 1),
    CONTENT_LIMITS.maxImageOutputs,
  );

  if (input.aspectRatio && model.capabilities.aspectRatios?.length) {
    if (!model.capabilities.aspectRatios.includes(input.aspectRatio)) {
      throw new GenerationValidationError("VALIDATION_ERROR", "Неподдерживаемое соотношение сторон");
    }
  }

  let qualityMeta: { requestedQuality: MediaQuality; effectiveQuality: string } | undefined;
  if (model.quality) {
    qualityMeta = resolveQuality(model, input.quality);
  } else if (input.resolution && model.capabilities.resolutions?.length) {
    if (!model.capabilities.resolutions.includes(input.resolution)) {
      throw new GenerationValidationError("VALIDATION_ERROR", "Неподдерживаемое разрешение");
    }
  }

  return {
    model,
    mode,
    settings: {
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      numOutputs,
      quality: qualityMeta?.requestedQuality ?? input.quality,
      effectiveQuality: qualityMeta?.effectiveQuality,
      selectionSource: input.selectionSource ?? selection.selectionSource,
    },
  };
}

export function validateVideoGenerationRequest(input: {
  modelId?: string;
  inputAssetIds?: string[];
  startFrameAssetId?: string;
  endFrameAssetId?: string;
  aspectRatio?: string;
  resolution?: string;
  quality?: MediaQuality;
  durationSec?: number;
  outputs?: number;
  mode?: string;
  selectionSource?: SelectionSource;
}): ValidatedVideoRequest {
  const inputAssetIds = input.inputAssetIds ?? [];
  const mode = inferVideoMode({
    startFrameAssetId: input.startFrameAssetId,
    endFrameAssetId: input.endFrameAssetId,
    inputAssetIds,
    requested: input.mode,
  });

  const selection = selectVideoModel({
    uiModelId: input.modelId,
    mode,
    needsEndFrame: Boolean(input.endFrameAssetId),
    referenceCount: inputAssetIds.length,
  });

  const model = input.modelId && input.modelId !== "auto"
    ? resolveVideoModel(input.modelId)
    : selection.model;

  // Check capability mismatch — do not silently swap model
  const required = requiredCapabilitiesForVideoMode(mode);
  const missing = checkModelCapabilityMismatch(model.id, required);
  if (missing.length && input.modelId && input.modelId !== "auto") {
    const alt = suggestAlternativeModel("video", required);
    const altName = alt?.displayName ?? "другую модель";
    throw new GenerationValidationError(
      "MODEL_CAPABILITY_MISMATCH",
      `Для этой операции выбранная модель не поддерживает нужный режим. Могу использовать ${altName}.`,
    );
  }

  const numOutputs = Math.min(
    Math.max(input.outputs ?? 1, 1),
    CONTENT_LIMITS.maxVideoOutputs,
  );

  if (input.endFrameAssetId && !model.capabilities.endFrame) {
    throw new GenerationValidationError(
      "MODEL_CAPABILITY_MISSING",
      "Выбранная модель не поддерживает end frame",
    );
  }
  if (
    (input.startFrameAssetId || mode === "image-to-video" || mode === "start-end-frames") &&
    !model.capabilities.startFrame &&
    !model.capabilities.referenceImages
  ) {
    throw new GenerationValidationError(
      "MODEL_CAPABILITY_MISSING",
      "Выбранная модель не поддерживает стартовый кадр",
    );
  }
  if (input.aspectRatio && model.capabilities.aspectRatios?.length) {
    if (!model.capabilities.aspectRatios.includes(input.aspectRatio)) {
      throw new GenerationValidationError("VALIDATION_ERROR", "Неподдерживаемое соотношение сторон");
    }
  }
  if (input.resolution && model.capabilities.resolutions?.length) {
    if (!model.capabilities.resolutions.includes(input.resolution)) {
      throw new GenerationValidationError("VALIDATION_ERROR", "Неподдерживаемое разрешение");
    }
  }
  if (
    input.durationSec !== undefined &&
    model.capabilities.durations?.length &&
    !model.capabilities.durations.includes(input.durationSec)
  ) {
    throw new GenerationValidationError("VALIDATION_ERROR", "Неподдерживаемая длительность");
  }

  let qualityMeta: { requestedQuality: MediaQuality; effectiveQuality: string } | undefined;
  if (model.quality) {
    qualityMeta = resolveQuality(model, input.quality);
  }

  return {
    model,
    mode,
    settings: {
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      durationSec: input.durationSec,
      numOutputs,
      startFrameAssetId: input.startFrameAssetId,
      endFrameAssetId: input.endFrameAssetId,
      quality: qualityMeta?.requestedQuality ?? input.quality,
      effectiveQuality: qualityMeta?.effectiveQuality,
      selectionSource: input.selectionSource ?? selection.selectionSource,
    },
  };
}

export { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL };
