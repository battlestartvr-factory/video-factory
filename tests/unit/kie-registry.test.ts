import { describe, expect, it } from "vitest";
import {
  KIE_MODEL_REGISTRY,
  getKieModelById,
  getDefaultLlmModel,
  getDefaultImageModel,
  getDefaultVideoModel,
  resolveModelId,
  getPublicModels,
} from "@/lib/models/kie/registry";
import { resolveReasoning } from "@/lib/models/kie/reasoning";
import { resolveQuality } from "@/lib/models/kie/quality";
import { analyzeProductionIntent, PRODUCTION_INTENT_CLARIFICATION } from "@/lib/models/kie/intent";
import { selectImageModel, selectVideoModel } from "@/lib/models/kie/selection";

describe("KIE Model Registry", () => {
  it("contains llm, the approved image surface, and video models", () => {
    expect(KIE_MODEL_REGISTRY.filter((m) => m.category === "llm").length).toBeGreaterThanOrEqual(4);
    expect(KIE_MODEL_REGISTRY.filter((m) => m.category === "image").map((m) => m.id)).toEqual([
      "gpt-image-2",
      "nano-banana-2",
      "nano-banana-pro",
    ]);
    expect(KIE_MODEL_REGISTRY.filter((m) => m.category === "video").length).toBeGreaterThanOrEqual(4);
  });

  it("defaults are correct", () => {
    expect(getDefaultLlmModel().id).toBe("gemini-3-6-flash");
    expect(getDefaultImageModel().id).toBe("gpt-image-2");
    expect(getDefaultVideoModel().id).toBe("kling-3");
  });

  it("resolves supported legacy aliases without exposing Nano Banana 2 Lite", () => {
    expect(resolveModelId("gemini-3-flash")).toBe("gemini-3-6-flash");
    expect(resolveModelId("nano-banana-2-lite")).toBe("nano-banana-2-lite");
    expect(getKieModelById("nano-banana-2-lite")).toBeUndefined();
    expect(resolveModelId("claude-sonnet-5")).toBe("claude-sonnet-4-5");
    expect(getKieModelById("gemini-3-flash")?.id).toBe("gemini-3-6-flash");
    expect(getKieModelById("claude-sonnet-5")?.id).toBe("claude-sonnet-4-5");
  });

  it("returns public metadata without secrets", () => {
    const models = getPublicModels("llm");
    for (const m of models) {
      expect(m).not.toHaveProperty("endpoint");
      expect(m).not.toHaveProperty("providerModel");
      expect(m).not.toHaveProperty("adapter");
    }
  });
});

describe("reasoning mapping", () => {
  it("maps GPT 5.6 Sol max to xhigh", () => {
    const model = getKieModelById("gpt-5-6-sol")!;
    const resolved = resolveReasoning(model, "max");
    expect(resolved.requestedReasoning).toBe("max");
    expect(resolved.effectiveReasoning).toBe("xhigh");
    expect(resolved.providerParam).toEqual({ reasoning: { effort: "xhigh" } });
  });

  it("maps Gemini max to highest supported level", () => {
    const model = getKieModelById("gemini-3-6-flash")!;
    const resolved = resolveReasoning(model, "max");
    expect(resolved.effectiveReasoning).toBe("high");
  });

  it("uses binary control for Claude Sonnet", () => {
    const model = getKieModelById("claude-sonnet-4-5")!;
    const resolved = resolveReasoning(model, "standard");
    expect(resolved.requestedReasoning).toBe("standard");
    expect(resolved.effectiveReasoning).toBe("disabled");
    expect(resolved.providerParam).toEqual({});
  });
});

describe("quality mapping", () => {
  it("maps Kling quality levels", () => {
    const model = getKieModelById("kling-3")!;
    expect(resolveQuality(model, "low").effectiveQuality).toBe("std");
    expect(resolveQuality(model, "medium").effectiveQuality).toBe("pro");
    expect(resolveQuality(model, "high").effectiveQuality).toBe("4K");
  });

  it("maps Veo variants", () => {
    const model = getKieModelById("veo-3-1")!;
    expect(resolveQuality(model, "low").effectiveQuality).toBe("lite");
    expect(resolveQuality(model, "high").effectiveQuality).toBe("quality");
  });

  it("maps all approved image model quality levels to explicit resolutions", () => {
    for (const id of ["gpt-image-2", "nano-banana-2", "nano-banana-pro"]) {
      const model = getKieModelById(id)!;
      expect(resolveQuality(model, "low").effectiveQuality).toBe("1K");
      expect(resolveQuality(model, "medium").effectiveQuality).toBe("2K");
      expect(resolveQuality(model, "high").effectiveQuality).toBe("4K");
    }
  });
});

describe("agent model selection", () => {
  it("keeps automatic poster requests on the approved image surface", () => {
    const result = selectImageModel({ needsTypography: true });
    expect(["gpt-image-2", "nano-banana-2", "nano-banana-pro"]).toContain(result.model.id);
    expect(result.selectionSource).toBe("agent");
  });

  it("respects explicit UI model selection", () => {
    const result = selectVideoModel({ uiModelId: "veo-3-1" });
    expect(result.model.id).toBe("veo-3-1");
    expect(result.selectionSource).toBe("ui");
  });

  it("defaults to Kling 3 for video", () => {
    const result = selectVideoModel({});
    expect(result.model.id).toBe("kling-3");
  });
});

describe("production intent", () => {
  it("detects ambiguous shorts requests", () => {
    const result = analyzeProductionIntent("Сделай шортс");
    expect(result.needsClarification).toBe(true);
    expect(PRODUCTION_INTENT_CLARIFICATION).toContain("Генерируем");
  });

  it("does not ask when intent is clear", () => {
    expect(analyzeProductionIntent("Сгенерируй видео из этой картинки в Kling 3").needsClarification).toBe(false);
    expect(analyzeProductionIntent("Возьми эти 8 видео и смонтируй из них Shorts").needsClarification).toBe(false);
  });
});
