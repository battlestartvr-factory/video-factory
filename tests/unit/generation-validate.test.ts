import { describe, expect, it } from "vitest";
import {
  inferImageMode,
  inferVideoMode,
  validateImageGenerationRequest,
  validateVideoGenerationRequest,
} from "@/lib/generation/validate";
import { GenerationValidationError } from "@/lib/generation/validate";

describe("canonical generation validation", () => {
  it("infers image and video modes from inputs", () => {
    expect(inferImageMode([])).toBe("text-to-image");
    expect(inferImageMode(["a"])).toBe("image-to-image");
    expect(inferVideoMode({ inputAssetIds: [] })).toBe("text-to-video");
    expect(
      inferVideoMode({
        inputAssetIds: [],
        startFrameAssetId: "s",
        endFrameAssetId: "e",
      }),
    ).toBe("start-end-frames");
  });

  it("accepts a capable image model and settings", () => {
    const result = validateImageGenerationRequest({
      modelId: "gpt-image-2",
      aspectRatio: "16:9",
      quality: "medium",
      outputs: 2,
    });
    expect(result.model.id).toBe("gpt-image-2");
    expect(result.settings.numOutputs).toBe(2);
    expect(result.settings.effectiveQuality).toBe("2K");
  });

  it("rejects end frame on models without the capability", () => {
    expect(() =>
      validateVideoGenerationRequest({
        modelId: "seedance-2-5",
        endFrameAssetId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrow(GenerationValidationError);
  });

  it("accepts start and end frames on kling-3", () => {
    const result = validateVideoGenerationRequest({
      modelId: "kling-3",
      startFrameAssetId: "11111111-1111-4111-8111-111111111111",
      endFrameAssetId: "22222222-2222-4222-8222-222222222222",
      durationSec: 10,
      aspectRatio: "16:9",
      quality: "medium",
    });
    expect(result.mode).toBe("start-end-frames");
    expect(result.settings.durationSec).toBe(10);
    expect(result.settings.effectiveQuality).toBe("pro");
  });

  it("accepts Kling reference mode through its generic reference-image capability", () => {
    const result = validateVideoGenerationRequest({
      modelId: "kling-3",
      mode: "reference-to-video",
      referenceCount: 2,
      selectionSource: "ui",
    });
    expect(result.model.id).toBe("kling-3");
    expect(result.mode).toBe("reference-to-video");
  });
});
