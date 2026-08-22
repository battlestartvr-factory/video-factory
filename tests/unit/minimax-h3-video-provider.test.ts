import { describe, expect, it } from "vitest";
import type { DurableVideoGeneration } from "@/lib/orchestrator/generation-videos";
import { buildVideoProviderRequest } from "@/worker/workflows/generation-video-v1";

function generation(overrides: Partial<DurableVideoGeneration> = {}): DurableVideoGeneration {
  return {
    id: "h3-video-gen-1",
    prompt: "AUTHENTIC PC CO-OP GAMEPLAY — one continuous player-recorded take.",
    modelId: "minimax-h3",
    mode: "image-to-video",
    settings: {
      aspectRatio: "16:9",
      durationSec: 10,
      resolution: "768P",
      sound: false,
      numOutputs: 1,
    },
    referenceAssets: [{ url: "https://example.test/approved-gameplay.png", role: "start_frame" }],
    status: "processing",
    ...overrides,
  };
}

describe("MiniMax H3 KIE provider mapping", () => {
  it("maps the primary 10s Stage 4 image-to-video request to Hailuo 03", () => {
    expect(buildVideoProviderRequest(generation())).toEqual({
      adapter: "market",
      model: "minimax/hailuo-03",
      input: {
        first_frame_url: "https://example.test/approved-gameplay.png",
        prompt: "AUTHENTIC PC CO-OP GAMEPLAY — one continuous player-recorded take.",
        duration: 10,
        resolution: "768P",
      },
    });
  });

  it("passes an optional approved end frame with the H3 first/last-frame contract", () => {
    expect(
      buildVideoProviderRequest(
        generation({
          mode: "start-end-frames",
          referenceAssets: [
            { url: "https://example.test/start.png", role: "start_frame" },
            { url: "https://example.test/end.png", role: "end_frame" },
          ],
        }),
      ),
    ).toEqual({
      adapter: "market",
      model: "minimax/hailuo-03",
      input: {
        first_frame_url: "https://example.test/start.png",
        last_frame_url: "https://example.test/end.png",
        prompt: "AUTHENTIC PC CO-OP GAMEPLAY — one continuous player-recorded take.",
        duration: 10,
        resolution: "768P",
      },
    });
  });

  it("uses 10 seconds and 768P as safe H3 defaults for text-to-video", () => {
    expect(
      buildVideoProviderRequest(
        generation({
          mode: "text-to-video",
          settings: { aspectRatio: "16:9", numOutputs: 1 },
          referenceAssets: [],
        }),
      ),
    ).toEqual({
      adapter: "market",
      model: "minimax/hailuo-03",
      input: {
        prompt: "AUTHENTIC PC CO-OP GAMEPLAY — one continuous player-recorded take.",
        duration: 10,
        aspect_ratio: "16:9",
        resolution: "768P",
      },
    });
  });

  it("rejects an H3 image-to-video request without the approved start frame", () => {
    expect(() =>
      buildVideoProviderRequest(generation({ referenceAssets: [] })),
    ).toThrow(/MiniMax H3 image-to-video requires an approved start frame/);
  });

  it("rejects unsupported H3 duration before a paid KIE submit", () => {
    expect(() =>
      buildVideoProviderRequest(
        generation({ settings: { aspectRatio: "16:9", durationSec: 16, resolution: "768P" } }),
      ),
    ).toThrow(/duration must be between 4 and 15 seconds/);
  });

  it("rejects an oversized H3 prompt instead of truncating gameplay constraints", () => {
    expect(() =>
      buildVideoProviderRequest(generation({ prompt: "x".repeat(5_001) })),
    ).toThrow(/gameplay prompt exceeds the 5000-character provider budget/);
  });
});
