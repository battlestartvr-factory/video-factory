import { describe, expect, it } from "vitest";
import type { AgentProvider } from "../../lib/agent/types";
import {
  captionGameplayReferenceImage,
  GameplayReferenceCaptionOutputError,
} from "../../lib/game-discovery/gameplay-reference-captioner";
import {
  GAMEPLAY_REFERENCE_NONE_VISIBLE,
  normalizeGameplayReferenceCaptionPayload,
} from "../../lib/game-discovery/gameplay-reference-indexing";

describe("observed cheap gameplay caption drift", () => {
  it("repairs provider formatting drift deterministically without another model call", () => {
    const normalized = normalizeGameplayReferenceCaptionPayload({
      fovEstimate: "~90 degrees",
      teammateCountVisible: "2 teammates",
      visibleInputAffordance: null,
      visibleGoal: "Gather loot and survive",
      visibleRisk: "yes",
      hudVisible: "not visible",
    }) as Record<string, unknown>;

    expect(normalized.fovEstimate).toBe(90);
    expect(normalized.teammateCountVisible).toBe(2);
    expect(normalized.visibleInputAffordance).toBe(GAMEPLAY_REFERENCE_NONE_VISIBLE);
    // A descriptive answer is not proof that the goal itself is visibly encoded in the frame.
    expect(normalized.visibleGoal).toBe(false);
    expect(normalized.visibleRisk).toBe(true);
    expect(normalized.hudVisible).toBe(false);
  });

  it("preserves usage and bounded raw output when schema validation still fails", async () => {
    let calls = 0;
    const run: AgentProvider["run"] = async () => {
      calls += 1;
      return {
        content: JSON.stringify({ cameraType: "cinematic" }),
        toolCalls: [],
        usage: { promptTokens: 111, completionTokens: 22, totalTokens: 133 },
        finishReason: "stop",
      };
    };

    let captured: unknown;
    try {
      await captionGameplayReferenceImage({
        referenceId: "gref-drift",
        gameName: "Test Game",
        filename: "frame.jpg",
        mimeType: "image/jpeg",
        buffer: Buffer.from("image"),
        upload: async () => "https://example.test/frame.jpg",
        provider: { run },
      });
    } catch (error) {
      captured = error;
    }

    expect(calls).toBe(1);
    expect(captured).toBeInstanceOf(GameplayReferenceCaptionOutputError);
    const error = captured as GameplayReferenceCaptionOutputError;
    expect(error.code).toBe("GAMEPLAY_REFERENCE_CAPTION_SCHEMA_INVALID");
    expect(error.usage).toEqual({ promptTokens: 111, completionTokens: 22, totalTokens: 133 });
    expect(error.rawResponse).toContain("cinematic");
    expect(error.validationError).toBeTruthy();
  });
});
