import { getModelById } from "@/lib/models/registry";
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, CONTENT_LIMITS } from "@/lib/agent/config";
import type { AIModel } from "@/lib/types/workspace";

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
  model: AIModel;
  mode: string;
  settings: {
    aspectRatio?: string;
    resolution?: string;
    numOutputs: number;
  };
}

export interface ValidatedVideoRequest {
  model: AIModel;
  mode: string;
  settings: {
    aspectRatio?: string;
    resolution?: string;
    durationSec?: number;
    numOutputs: number;
    startFrameAssetId?: string;
    endFrameAssetId?: string;
  };
}

export function resolveImageModel(modelId?: string): AIModel {
  const id = modelId || DEFAULT_IMAGE_MODEL;
  const model = getModelById(id);
  if (!model || !model.capabilities.imageGeneration) {
    throw new GenerationValidationError("MODEL_CAPABILITY_MISSING", "Модель не поддерживает генерацию изображений");
  }
  return model;
}

export function resolveVideoModel(modelId?: string): AIModel {
  const id = modelId || DEFAULT_VIDEO_MODEL;
  const model = getModelById(id);
  if (!model || !model.capabilities.videoGeneration) {
    throw new GenerationValidationError("MODEL_CAPABILITY_MISSING", "Модель не поддерживает генерацию видео");
  }
  return model;
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

export function validateImageGenerationRequest(input: {
  modelId?: string;
  inputAssetIds?: string[];
  aspectRatio?: string;
  resolution?: string;
  outputs?: number;
  mode?: string;
}): ValidatedImageRequest {
  const model = resolveImageModel(input.modelId);
  const inputAssetIds = input.inputAssetIds ?? [];
  const mode = inferImageMode(inputAssetIds, input.mode);
  const numOutputs = Math.min(
    Math.max(input.outputs ?? 1, 1),
    CONTENT_LIMITS.maxImageOutputs,
  );

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

  return {
    model,
    mode,
    settings: {
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      numOutputs,
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
  durationSec?: number;
  outputs?: number;
  mode?: string;
}): ValidatedVideoRequest {
  const model = resolveVideoModel(input.modelId);
  const inputAssetIds = input.inputAssetIds ?? [];
  const mode = inferVideoMode({
    startFrameAssetId: input.startFrameAssetId,
    endFrameAssetId: input.endFrameAssetId,
    inputAssetIds,
    requested: input.mode,
  });
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
    },
  };
}
