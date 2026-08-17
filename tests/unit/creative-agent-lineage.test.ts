import { describe, expect, it } from "vitest";
import {
  collectGenerationCards,
  dedupeSourceCitations,
  inferCreativeRunType,
  sanitizeGenerationCard,
  sanitizeSourceUrl,
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

  it("strips ephemeral query data from generated asset URLs", () => {
    const sanitized = sanitizeGenerationCard(imageGeneration);
    expect(sanitized.outputs).toEqual([
      { kind: "image", url: "https://cdn.example.com/result.png" },
    ]);
  });

  it("redacts source credentials without removing meaningful query parameters", () => {
    expect(
      sanitizeSourceUrl("https://youtube.com/watch?v=abc123&token=secret"),
    ).toBe("https://youtube.com/watch?v=abc123&token=[redacted]");
  });

  it("deduplicates source citations that differ only by a signed token", () => {
    const sources = dedupeSourceCitations([
      {
        source: "web",
        title: "Example",
        url: "https://example.com/article?id=42&token=one",
      },
      {
        source: "web",
        title: "Example",
        url: "https://example.com/article?id=42&token=two",
      },
    ]);
    expect(sources).toHaveLength(1);
  });
});
