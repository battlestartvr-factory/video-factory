import { describe, expect, it } from "vitest";
import {
  buildGameplayReferenceCoverageBlock,
  GAMEPLAY_REFERENCE_SET_INSUFFICIENT,
  GameplayReferenceServiceError,
  parseGameplayReferenceCoverageGap,
  stripRepeatedCodePrefix,
} from "../../lib/game-discovery/gameplay-reference-coverage";

describe("Stage 4 gameplay reference coverage", () => {
  it("normalizes duplicated upstream error prefixes", () => {
    expect(
      stripRepeatedCodePrefix(
        GAMEPLAY_REFERENCE_SET_INSUFFICIENT,
        "GAMEPLAY_REFERENCE_SET_INSUFFICIENT:GAMEPLAY_REFERENCE_SET_INSUFFICIENT:3:missing=gameplay_camera",
      ),
    ).toBe("3:missing=gameplay_camera");

    const error = new GameplayReferenceServiceError({
      code: GAMEPLAY_REFERENCE_SET_INSUFFICIENT,
      detail: "GAMEPLAY_REFERENCE_SET_INSUFFICIENT:3:missing=gameplay_camera",
      status: 409,
    });
    expect(error.message).toBe("GAMEPLAY_REFERENCE_SET_INSUFFICIENT:3:missing=gameplay_camera");
    expect(error.detail).toBe("3:missing=gameplay_camera");
  });

  it("parses a missing camera purpose without weakening camera grammar", () => {
    const error = new GameplayReferenceServiceError({
      code: GAMEPLAY_REFERENCE_SET_INSUFFICIENT,
      detail: "3:missing=gameplay_camera",
      status: 409,
    });
    expect(parseGameplayReferenceCoverageGap(error)).toEqual({
      availableReferenceCount: 3,
      missingPurposes: ["gameplay_camera"],
    });
    expect(
      buildGameplayReferenceCoverageBlock({
        error,
        conceptId: "live-wire-logistics",
        momentId: "live-wire-logistics-moment-1",
        shotId: "live-wire-logistics-shot-1",
        camera: "Top-down isometric view focused on the two-player work zone",
      }),
    ).toEqual({
      code: GAMEPLAY_REFERENCE_SET_INSUFFICIENT,
      conceptId: "live-wire-logistics",
      momentId: "live-wire-logistics-moment-1",
      shotId: "live-wire-logistics-shot-1",
      camera: "Top-down isometric view focused on the two-player work zone",
      availableReferenceCount: 3,
      missingPurposes: ["gameplay_camera"],
      providerCallsMade: 0,
      blockedAt: "reference_retrieval",
    });
  });

  it("does not downgrade unrelated Stage 4 failures into coverage gaps", () => {
    const error = new GameplayReferenceServiceError({
      code: "GAMEPLAY_REFERENCE_STAGE4_UPSTREAM_FAILED",
      detail: "service unavailable",
      status: 503,
    });
    expect(parseGameplayReferenceCoverageGap(error)).toBeNull();
    expect(
      buildGameplayReferenceCoverageBlock({
        error,
        conceptId: "concept-1",
        momentId: "moment-1",
        shotId: "shot-1",
        camera: "third-person follow",
      }),
    ).toBeNull();
  });
});
