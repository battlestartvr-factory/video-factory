import { describe, it, expect } from "vitest";
import { MODEL_REGISTRY, getModelById, modelSupports } from "@/lib/models/registry";
import { isAllowedMime, getAcceptString } from "@/lib/attachments/mime";

describe("model registry", () => {
  it("contains chat, image, and video models", () => {
    expect(MODEL_REGISTRY.some((m) => m.capabilities.chat)).toBe(true);
    expect(MODEL_REGISTRY.some((m) => m.capabilities.imageGeneration)).toBe(true);
    expect(MODEL_REGISTRY.some((m) => m.capabilities.videoGeneration)).toBe(true);
  });

  it("modelSupports checks capabilities", () => {
    expect(modelSupports("kling-3", "endFrame")).toBe(true);
    expect(modelSupports("seedance-2-5", "endFrame")).toBe(true);
    expect(modelSupports("gemini-3-6-flash", "toolCalling")).toBe(true);
  });

  it("getModelById returns model", () => {
    expect(getModelById("gemini-3-6-flash")?.name).toBe("Gemini 3.6 Flash");
  });

  it("resolves legacy model ids", () => {
    expect(getModelById("gemini-3-flash")?.id).toBe("gemini-3-6-flash");
  });
});

describe("attachment mime registry", () => {
  it("allows standard mime types", () => {
    expect(isAllowedMime("image/png")).toBe(true);
    expect(isAllowedMime("application/pdf")).toBe(true);
    expect(isAllowedMime("application/exe")).toBe(false);
  });

  it("provides accept string for file inputs", () => {
    expect(getAcceptString()).toContain("image/png");
    expect(getAcceptString()).toContain("video/mp4");
  });
});
