import { describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "../../lib/agent/types";
import {
  captionGameplayReferenceImage,
  GAMEPLAY_REFERENCE_CAPTION_MODEL,
} from "../../lib/game-discovery/gameplay-reference-captioner";
import {
  findPerceptualNearDuplicate,
  perceptualHashHammingDistance,
} from "../../lib/game-discovery/gameplay-reference-dedupe";

function validCaptionJson() {
  return JSON.stringify({
    cameraType: "first_person",
    cameraDistance: "interaction distance",
    cameraHeight: "standing eye height",
    fovEstimate: 90,
    playableCharacterVisible: false,
    handsVisible: true,
    heldToolVisible: true,
    crosshairVisible: false,
    hudVisible: true,
    controllablePlayerObvious: true,
    howPlayerControlIsVisible: "The held tool is aligned with the player camera.",
    currentPlayerAction: "The player cuts a metal support with a held tool.",
    visibleInputAffordance: "Held cutting tool and object-state HUD.",
    playerTarget: "Metal support",
    gameResponse: "The support separates and the attached load begins to shift.",
    teammateCountVisible: 1,
    teammateDistance: "a few meters",
    teammateRole: "Stabilizes the shared load with a tether.",
    coopDependencyVisible: true,
    sharedObjectVisible: true,
    informationAsymmetryVisible: false,
    rescueVisible: false,
    coordinationVisible: true,
    coreAction: "Cut a support while a teammate stabilizes the load.",
    mechanicTags: ["cutting", "shared_object", "physics"],
    interactionModel: ["hold_to_act", "physics_coordination"],
    dangerSource: "Unstable shared load",
    failureRisk: "The load can slide and pull unsecured players.",
    successState: "The salvage separates while remaining controlled.",
    physicsInteraction: "Cutting changes rigid-body balance.",
    environmentType: "Industrial salvage platform",
    primaryFocus: "Held cutting tool contacting the support",
    secondaryFocus: "Teammate and tether",
    readableWithoutContext: true,
    visibleGoal: true,
    visibleRisk: true,
    uiSupportsAction: true,
    visualClutter: "low",
    artDirection: "Stylized industrial indie co-op.",
    realismLevel: "stylized",
    productionScopeFeel: "indie",
    stylizationTags: ["simple_materials", "chunky_shapes"],
    gameplayDescription:
      "First-person player holds a cutting tool against a metal support while one teammate stabilizes the same load with a tether; the support separates and the load shifts, making the action, co-op dependency, and fall risk visible.",
    whyThisLooksLikeGameplay:
      "The camera is physically attached to the player, the tool occupies foreground interaction space, the teammate remains at playable distance, and the world responds immediately to the visible tool action.",
  });
}

describe("cheap gameplay reference captioner", () => {
  it("uses one vision model call and no repair call when deterministic validation succeeds", async () => {
    const upload = vi.fn(async () => "https://example.test/reference.jpg");
    const run = vi.fn(async () => ({
      content: validCaptionJson(),
      toolCalls: [],
      usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      finishReason: "stop" as const,
    }));
    const provider = { run } satisfies AgentProvider;

    const result = await captionGameplayReferenceImage({
      referenceId: "gref-test",
      gameName: "Test Game",
      filename: "test.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from("image"),
      upload,
      provider,
    });

    expect(upload).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.model).toBe(GAMEPLAY_REFERENCE_CAPTION_MODEL);
    expect(result.usage.totalTokens).toBe(300);
    expect(result.caption.cameraType).toBe("first_person");

    const request = run.mock.calls[0][0];
    expect(request.tools).toEqual([]);
    expect(request.messages[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text" }),
        expect.objectContaining({
          type: "image_url",
          image_url: { url: "https://example.test/reference.jpg" },
        }),
      ]),
    );
  });

  it("fails after the single paid call when semantic/schema output is invalid", async () => {
    const run = vi.fn(async () => ({
      content: JSON.stringify({ cameraType: "cinematic" }),
      toolCalls: [],
      usage: {},
      finishReason: "stop" as const,
    }));

    await expect(
      captionGameplayReferenceImage({
        referenceId: "gref-bad",
        gameName: "Test Game",
        filename: "bad.jpg",
        mimeType: "image/jpeg",
        buffer: Buffer.from("image"),
        upload: async () => "https://example.test/bad.jpg",
        provider: { run },
      }),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("gameplay reference perceptual dedupe", () => {
  it("computes deterministic bit hamming distance for hexadecimal hashes", () => {
    expect(perceptualHashHammingDistance("0000000000000000", "0000000000000001")).toBe(1);
    expect(perceptualHashHammingDistance("ffffffffffffffff", "0000000000000000")).toBe(64);
  });

  it("points a near duplicate at the existing canonical reference", () => {
    const duplicate = findPerceptualNearDuplicate({
      referenceId: "new",
      perceptualHash: "0000000000000003",
      maxDistance: 4,
      candidates: [
        {
          referenceId: "near",
          perceptualHash: "0000000000000001",
          canonicalReferenceId: "canonical",
        },
        { referenceId: "far", perceptualHash: "ffffffffffffffff" },
      ],
    });
    expect(duplicate).toEqual({ canonicalReferenceId: "canonical", distance: 1 });
  });
});
