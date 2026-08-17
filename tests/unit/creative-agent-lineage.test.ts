import { describe, expect, it } from "vitest";
import {
  collectGenerationCards,
  dedupeSourceCitations,
  inferCreativeRunType,
  sanitizeGenerationCard,
} from "@/lib/creative/agent-lineage";
import type { GenerationCardData, MessageMetadata } from "@/lib/types/workspace";

const imageGeneration: GenerationCardData = {
  generationId: "gen-image-1",
  type: "image",
  mode: "text-to-image",
  status: "completed",
  prompt: "Create a cinematic frame",
  modelId: "nano-banana",
  outputs: [
    {
      kind: "image",
      url: "https://cdn.example.com/result.png?token=secret&expires=999",
    },
  ],
};

describe("creative agent lineage mapping", () => {
  it("maps research and concept turns to the creative data model", () => {
    expect(inferCreativeRunType({ intent: "knowledge" })).toBe("research");
    expect(inferCreativeRunType({ intent: "web" })).toBe("research");
    expect(inferCreativeRunType({ intent: "general" })).toBe("concept");
    expect(inferCreativeRunType({ intent: "memory" })).toBe("mixed");
  });

  it("lets actual generation output override the text intent", () => {
    expect(
      inferCreativeRunType({ intent: "general", generations: [imageGeneration] }),
    ).toBe("image");
  });

  it("deduplicates generation cards when metadata carries both legacy and array forms", () => {
    const metadata: MessageMetadata = {
      type: "generation",
      generation: imageGeneration,
      generations: [imageGeneration],
    };
    expect(collectGenerationCards(metadata)).toHaveLength(1);
    expect(collectGenerationCards(metadata)[0]?.generationId).toBe("gen-image-1");
  });

  it("strips query credentials from generation output URLs before lineage storage", () => {
    const sanitized = sanitizeGenerationCard(imageGeneration);
    expect(sanitized.outputs).toEqual([
      { kind: "image", url: "https://cdn.example.com/result.png" },
    ]);
  });

  it("deduplicates equivalent source citations after URL sanitization", () => {
    const sources = dedupeSourceCitations([
      {
        source: "web",
        title: "Example",
        url: "https://example.com/article?utm_source=one",
      },
      {
        source: "web",
        title: "Example",
        url: "https://example.com/article?utm_source=two",
      },
    ]);
    expect(sources).toHaveLength(1);
  });
});
