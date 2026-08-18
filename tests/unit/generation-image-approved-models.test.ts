import { describe, expect, it } from "vitest";
import type { DurableImageGeneration } from "@/lib/orchestrator/generation-images";
import { buildImageProviderRequest } from "@/worker/workflows/generation-image-v1";

function generation(overrides: Partial<DurableImageGeneration> = {}): DurableImageGeneration {
  return {
    id: "generation-test",
    prompt: "Create a cinematic product image",
    modelId: "nano-banana-pro",
    mode: "text-to-image",
    settings: {
      aspectRatio: "16:9",
      effectiveQuality: "4K",
    },
    referenceAssets: [],
    status: "queued",
    ...overrides,
  };
}

describe("approved durable image models", () => {
  it("maps Nano Banana Pro to the unified market-task payload", () => {
    const request = buildImageProviderRequest(
      generation({
        mode: "reference-images",
        referenceAssets: [
          { url: "https://example.com/reference-a.png", mimeType: "image/png" },
          { url: "https://example.com/reference-b.jpg", mimeType: "image/jpeg" },
        ],
      }),
    );

    expect(request).toEqual({
      model: "nano-banana-pro",
      input: {
        prompt: "Create a cinematic product image",
        image_input: [
          "https://example.com/reference-a.png",
          "https://example.com/reference-b.jpg",
        ],
        aspect_ratio: "16:9",
        resolution: "4K",
        output_format: "png",
      },
    });
  });

  it("adds extracted brief text to the provider prompt without treating it as an image", () => {
    const request = buildImageProviderRequest(
      generation({
        modelId: "nano-banana-2",
        settings: {
          aspectRatio: "1:1",
          effectiveQuality: "2K",
          documentContext: "Brand brief: minimal black packaging, premium studio lighting.",
        },
      }),
    );

    expect(request.model).toBe("nano-banana-2");
    expect(request.input.image_input).toEqual([]);
    expect(String(request.input.prompt)).toContain("Create a cinematic product image");
    expect(String(request.input.prompt)).toContain("Brand brief: minimal black packaging");
  });

  it("keeps GPT Image 2 references on its image-to-image provider route", () => {
    const request = buildImageProviderRequest(
      generation({
        modelId: "gpt-image-2",
        mode: "image-edit",
        settings: { aspectRatio: "4:3", effectiveQuality: "2K" },
        referenceAssets: [{ url: "https://example.com/source.png", mimeType: "image/png" }],
      }),
    );

    expect(request.model).toBe("gpt-image-2-image-to-image");
    expect(request.input.input_urls).toEqual(["https://example.com/source.png"]);
    expect(request.input.resolution).toBe("2K");
  });
});
