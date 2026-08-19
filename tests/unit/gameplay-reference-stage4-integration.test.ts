import { describe, expect, it } from "vitest";
import {
  renderGameplayReferenceInstructionBlock,
  stage4GameplayReferenceSetSchema,
} from "../../lib/game-discovery/gameplay-reference-stage4";

function referenceSet(cameraGame = "R.E.P.O.") {
  const make = (
    purpose: "gameplay_camera" | "interaction" | "coop" | "art_direction",
    index: number,
    gameName: string,
  ) => ({
    referenceId: `gref-${purpose}-${index}`,
    purpose,
    gameId: `game-${index}`,
    gameName,
    driveFileId: `drive-${index}`,
    score: 0.8,
    whySelected: ["readable gameplay evidence"],
    gameplayDescription:
      "The player-controlled action, teammate placement and immediate world response are visible in the same gameplay frame.",
    whyThisLooksLikeGameplay:
      "The camera belongs to a controllable player and a visible affordance connects to an immediate game response.",
  });

  return stage4GameplayReferenceSetSchema.parse({
    schema: "stage4_gameplay_reference_set",
    version: 1,
    references: [
      make("gameplay_camera", 1, cameraGame),
      make("interaction", 2, "Abiotic Factor"),
      make("coop", 3, "PEAK"),
      make("art_direction", 4, "Lethal Company"),
    ],
  });
}

describe("Stage 4 gameplay reference transport", () => {
  it("keeps camera, interaction, coop and art purposes separated", () => {
    const block = renderGameplayReferenceInstructionBlock(referenceSet());
    expect(block).toContain("Reference A — GAMEPLAY_CAMERA — R.E.P.O.");
    expect(block).toContain("Use only for player-camera grammar");
    expect(block).toContain("Reference D — ART_DIRECTION — Lethal Company");
    expect(block).toContain("Do not inherit its camera grammar");
    expect(block).toContain("Do not copy game identity");
  });

  it("limits a provider reference set to eight ordered images", () => {
    const tooMany = {
      ...referenceSet(),
      references: Array.from({ length: 9 }, (_, index) => ({
        ...referenceSet().references[0],
        referenceId: `ref-${index}`,
        driveFileId: `drive-${index}`,
      })),
    };
    expect(stage4GameplayReferenceSetSchema.safeParse(tooMany).success).toBe(false);
  });
});
