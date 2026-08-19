import { describe, expect, it } from "vitest";
import { retrievePurposeAwareGameplayReferences } from "../../lib/game-discovery/gameplay-reference-purpose-retrieval";
import {
  gameplayReferenceNeedSpecV1Schema,
  type GameplayReferenceCandidate,
} from "../../lib/game-discovery/gameplay-reference-retrieval";

function candidate(input: {
  referenceId: string;
  gameId: string;
  cameraType?: GameplayReferenceCandidate["cameraType"];
  coop?: boolean;
  heldTool?: boolean;
  hud?: boolean;
  style?: string[];
}): GameplayReferenceCandidate {
  return {
    referenceId: input.referenceId,
    gameId: input.gameId,
    gameName: input.gameId,
    driveFileId: `drive-${input.referenceId}`,
    sourceUrl: `https://drive.google.com/open?id=${input.referenceId}`,
    cameraType: input.cameraType ?? "first_person",
    controllablePlayerObvious: true,
    handsVisible: input.heldTool ?? false,
    heldToolVisible: input.heldTool ?? false,
    crosshairVisible: false,
    hudVisible: input.hud ?? false,
    teammateCountVisible: input.coop ? 1 : 0,
    coopDependencyVisible: input.coop ?? false,
    sharedObjectVisible: input.coop ?? false,
    coordinationVisible: input.coop ?? false,
    coreAction: input.heldTool
      ? "Player uses a held tool on a physical target."
      : "Player moves through a playable space.",
    currentPlayerAction: input.heldTool
      ? "Manipulates a target with a held tool."
      : "Navigates the environment.",
    visibleInputAffordance: input.heldTool
      ? "Held tool in foreground."
      : "Player-bound camera and HUD.",
    gameResponse: input.heldTool
      ? "Target object changes state immediately."
      : "World navigation responds to movement.",
    mechanicTags: input.heldTool ? ["physics", "tool_interaction"] : ["navigation"],
    interactionModel: input.coop ? ["shared_object", "coordination"] : ["direct_control"],
    failureRisk: input.coop ? "The shared object can be lost." : null,
    dangerSource: null,
    physicsInteraction: input.heldTool ? "Physical target response." : null,
    readableWithoutContext: true,
    visibleGoal: true,
    visibleRisk: input.coop ?? false,
    uiSupportsAction: input.hud ?? false,
    productionScopeFeel: "indie",
    stylizationTags: input.style ?? ["stylized_indie"],
    artDirection: "Stylized indie gameplay with simplified materials.",
    gameplayDescription:
      "A concrete active gameplay frame with a player-bound camera and readable action evidence.",
    whyThisLooksLikeGameplay:
      "The camera belongs to the player and the world visibly responds to play.",
  };
}

const need = gameplayReferenceNeedSpecV1Schema.parse({
  schema: "gameplay_reference_need",
  version: 1,
  queryText: "first-person cutting tool physical shared load tilt co-op stylized indie gameplay",
  cameraTypes: ["first_person"],
  mechanicTags: ["physics", "tool_interaction"],
  interactionModel: ["shared_object", "coordination"],
  playerAction: "cut a structural support",
  requireCoopDependency: true,
  requireSharedObject: null,
  requireVisibleRisk: null,
  productionScopeFeel: ["indie", "AA"],
  stylizationTags: ["stylized_indie"],
  highReadability: true,
  purposes: ["gameplay_camera", "interaction", "coop", "art_direction"],
  maxResults: 4,
});

describe("purpose-aware gameplay reference retrieval", () => {
  it("returns four roles even when only the coop reference shows explicit dependency", () => {
    const result = retrievePurposeAwareGameplayReferences({
      need,
      candidates: [
        candidate({ referenceId: "camera", gameId: "Phasmophobia", heldTool: true, hud: true }),
        candidate({ referenceId: "interaction", gameId: "Abiotic", heldTool: true }),
        candidate({ referenceId: "art", gameId: "Lethal", style: ["stylized_indie"] }),
        candidate({ referenceId: "coop", gameId: "REPO", coop: true, heldTool: true }),
      ],
    });

    expect(result.references.map((item) => item.purpose)).toEqual([
      "gameplay_camera",
      "interaction",
      "coop",
      "art_direction",
    ]);
    expect(result.references).toHaveLength(4);
    expect(result.references.find((item) => item.purpose === "coop")?.reference.referenceId).toBe(
      "coop",
    );
    expect(
      result.references
        .filter((item) => item.purpose !== "coop")
        .every((item) => item.reference.referenceId !== "coop"),
    ).toBe(true);
  });

  it("fails closed on coop-purpose coverage when no explicit coop gameplay frame exists", () => {
    const result = retrievePurposeAwareGameplayReferences({
      need,
      candidates: [
        candidate({ referenceId: "camera", gameId: "Phasmophobia", heldTool: true, hud: true }),
        candidate({ referenceId: "interaction", gameId: "Abiotic", heldTool: true }),
        candidate({ referenceId: "art", gameId: "Lethal" }),
      ],
    });
    expect(result.references.some((item) => item.purpose === "coop")).toBe(false);
    expect(result.references).toHaveLength(3);
  });

  it("uses the requested camera only for camera grammar while allowing other purposes from other cameras", () => {
    const thirdPersonNeed = gameplayReferenceNeedSpecV1Schema.parse({
      ...need,
      queryText: "third-person shared platform physics failure co-op stylized indie gameplay",
      cameraTypes: ["third_person_follow"],
    });
    const result = retrievePurposeAwareGameplayReferences({
      need: thirdPersonNeed,
      candidates: [
        candidate({
          referenceId: "third-camera",
          gameId: "Valheim",
          cameraType: "third_person_follow",
          hud: true,
        }),
        candidate({ referenceId: "interaction-first", gameId: "Abiotic", heldTool: true }),
        candidate({ referenceId: "art-first", gameId: "Lethal", style: ["stylized_indie"] }),
        candidate({ referenceId: "coop-first", gameId: "REPO", coop: true, heldTool: true }),
      ],
    });

    expect(result.references).toHaveLength(4);
    expect(
      result.references.find((item) => item.purpose === "gameplay_camera")?.reference.referenceId,
    ).toBe("third-camera");
    expect(
      result.references.find((item) => item.purpose === "coop")?.reference.cameraType,
    ).toBe("first_person");
  });

  it("surfaces a camera-library gap without discarding valid non-camera evidence", () => {
    const thirdPersonNeed = gameplayReferenceNeedSpecV1Schema.parse({
      ...need,
      queryText: "third-person shared platform physics failure co-op stylized indie gameplay",
      cameraTypes: ["third_person_follow"],
    });
    const result = retrievePurposeAwareGameplayReferences({
      need: thirdPersonNeed,
      candidates: [
        candidate({ referenceId: "interaction-first", gameId: "Abiotic", heldTool: true }),
        candidate({ referenceId: "art-first", gameId: "Lethal", style: ["stylized_indie"] }),
        candidate({ referenceId: "coop-first", gameId: "REPO", coop: true, heldTool: true }),
      ],
    });

    expect(result.references.some((item) => item.purpose === "gameplay_camera")).toBe(false);
    expect(result.references.map((item) => item.purpose).sort()).toEqual([
      "art_direction",
      "coop",
      "interaction",
    ]);
  });
});
