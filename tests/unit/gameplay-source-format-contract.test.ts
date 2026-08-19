import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { shotSpecV1Schema } from "../../lib/game-discovery/schemas";

function validShot(aspectRatio: string) {
  return {
    schema: "gameplay_shot",
    version: 1,
    shotId: "shot-1",
    momentId: "moment-1",
    order: 0,
    durationSec: 5,
    purpose: "mechanic",
    actors: ["Player", "Teammate"],
    action: "Player interacts while the teammate performs a dependent task.",
    camera: "Third-person follow camera bound to the controllable player.",
    environment: "Readable gameplay environment.",
    continuity: { preserve: [] },
    expectedEvidence: ["Visible player input and world response."],
    generationPlan: {
      keyframeRequired: true,
      imageModel: "nano-banana-2",
      videoModel: "kling-3",
      videoMode: "image-to-video",
      aspectRatio,
      durationSec: 5,
    },
    metadata: {},
  };
}

describe("desktop gameplay source format", () => {
  it("requires Stage 4 gameplay shots to be widescreen 16:9", () => {
    expect(shotSpecV1Schema.safeParse(validShot("16:9")).success).toBe(true);
    expect(shotSpecV1Schema.safeParse(validShot("9:16")).success).toBe(false);
  });

  it("keeps portrait conversion downstream and requests a 2K widescreen reference still", async () => {
    const [planner, referenceRoute, widescreenMigration, reference2kMigration] = await Promise.all([
      readFile("lib/game-discovery/shot-planner.ts", "utf8"),
      readFile("app/api/internal/gameplay-reference-stage4/route.ts", "utf8"),
      readFile("supabase/migrations/20260819102500_gameplay_widescreen_source_v1.sql", "utf8"),
      readFile("supabase/migrations/20260819110500_gameplay_reference_2k_v1.sql", "utf8"),
    ]);
    expect(planner).toContain('aspectRatio:"16:9"');
    expect(planner).toContain("normal widescreen 16:9 desktop PC capture");
    expect(referenceRoute).toContain('aspectRatio: "16:9"');
    expect(referenceRoute).toContain('effectiveQuality: "2K"');
    expect(widescreenMigration).toContain("'aspectRatio','16:9'");
    expect(widescreenMigration).toContain("'effectiveQuality','pro'");
    expect(widescreenMigration).toContain("'source_capture_format','desktop_pc_16x9'");
    expect(reference2kMigration).toContain("'aspectRatio','16:9'");
    expect(reference2kMigration).toContain("'effectiveQuality','2K'");
    expect(reference2kMigration).toContain("'effective_quality','2K'");
  });

  it("preserves full gameplay evidence in a landscape master and blurred-fill social edit", async () => {
    const assembly = await readFile("lib/game-discovery/assembly.ts", "utf8");
    expect(assembly).toContain("LANDSCAPE_WIDTH = 1920");
    expect(assembly).toContain("LANDSCAPE_HEIGHT = 1080");
    expect(assembly).toContain("SOCIAL_WIDTH = 1080");
    expect(assembly).toContain("SOCIAL_HEIGHT = 1920");
    expect(assembly).toContain('verticalization: "full_landscape_frame_over_blurred_background"');
    expect(assembly).toContain("gameplayCrop: false");
    expect(assembly).toContain("boxblur=32:2");
    expect(assembly).toContain('variant: "landscape_master"');
    expect(assembly).toContain('variant: "vertical_social"');
  });
});
