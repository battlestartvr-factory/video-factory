import { describe, expect, it } from "vitest";
import {
  buildGameplayReferenceCaptionPrompt,
  buildGameplayReferenceEmbeddingText,
  materializeGameplayReferenceSpec,
  parseGameplayReferenceCaption,
} from "../../lib/game-discovery/gameplay-reference-indexing";
import {
  buildGameplayReferenceNeed,
  retrieveGameplayReferences,
  type GameplayReferenceCandidate,
} from "../../lib/game-discovery/gameplay-reference-retrieval";
import type { GameplayMomentSpecV1, ShotSpecV1 } from "../../lib/game-discovery/schemas";

function rawCaption(overrides: Record<string, unknown> = {}) {
  return {
    cameraType: "first-person",
    cameraDistance: " interaction distance ",
    cameraHeight: "standing eye height",
    fovEstimate: "90",
    playableCharacterVisible: "false",
    handsVisible: "true",
    heldToolVisible: "true",
    crosshairVisible: "0",
    hudVisible: "yes",
    controllablePlayerObvious: "true",
    howPlayerControlIsVisible: "Held tool is aligned with the player camera.",
    currentPlayerAction: "Player pulls a heavy cabinet through a doorway.",
    visibleInputAffordance: "Held grab tool and object-state HUD.",
    playerTarget: "Heavy cabinet",
    gameResponse: "The cabinet rotates and collides with the door frame.",
    teammateCountVisible: "1",
    teammateDistance: "a few meters",
    teammateRole: "Counter-pulls the same object.",
    coopDependencyVisible: "true",
    sharedObjectVisible: "true",
    informationAsymmetryVisible: "false",
    rescueVisible: "false",
    coordinationVisible: "true",
    coreAction: "Two players manipulate one heavy object.",
    mechanicTags: "physical_manipulation, shared_object, physical_manipulation",
    interactionModel: ["physics_coordination"],
    dangerSource: "Narrow doorway",
    failureRisk: "Object can collide or be dropped.",
    successState: "Object clears the doorway.",
    physicsInteraction: "Shared rigid-body manipulation.",
    environmentType: "Interior corridor",
    primaryFocus: "Held tool and cabinet",
    secondaryFocus: "teammate",
    readableWithoutContext: "true",
    visibleGoal: "true",
    visibleRisk: "true",
    uiSupportsAction: "true",
    visualClutter: "LOW",
    artDirection: "Stylized low-detail industrial co-op.",
    realismLevel: "stylized",
    productionScopeFeel: "aa",
    stylizationTags: "chunky_shapes, simple_materials",
    gameplayDescription:
      "First-person player uses a held grab tool to pull a heavy cabinet through a narrow doorway while a teammate counter-pulls the same object; the object-state HUD and collision risk make the interaction immediately legible.",
    whyThisLooksLikeGameplay:
      "The camera belongs to the controllable player, the held tool occupies foreground space, the teammate remains at playable distance, and the object visibly responds to manipulation.",
    ...overrides,
  };
}

function candidate(input: Partial<GameplayReferenceCandidate> & Pick<GameplayReferenceCandidate, "referenceId" | "gameId" | "gameName">): GameplayReferenceCandidate {
  return {
    referenceId: input.referenceId,
    gameId: input.gameId,
    gameName: input.gameName,
    driveFileId: `drive-${input.referenceId}`,
    sourceUrl: "https://store.steampowered.com/",
    cameraType: "first_person",
    controllablePlayerObvious: true,
    handsVisible: true,
    heldToolVisible: true,
    crosshairVisible: false,
    hudVisible: true,
    teammateCountVisible: 1,
    coopDependencyVisible: true,
    sharedObjectVisible: true,
    coordinationVisible: true,
    coreAction: "physical manipulation of a shared heavy object",
    currentPlayerAction: "cut and pull a heavy object",
    visibleInputAffordance: "held tool",
    gameResponse: "object shifts after the tool action",
    mechanicTags: ["physical_manipulation", "shared_object"],
    interactionModel: ["physics_coordination"],
    failureRisk: "falling or sliding",
    dangerSource: "unstable platform",
    physicsInteraction: "rigid-body balance",
    readableWithoutContext: true,
    visibleGoal: true,
    visibleRisk: true,
    uiSupportsAction: true,
    productionScopeFeel: "indie",
    stylizationTags: ["simple_materials"],
    artDirection: "stylized indie",
    gameplayDescription: "player manipulates an object while teammate supports it",
    whyThisLooksLikeGameplay: "player-bound camera and immediate world response",
    semanticSimilarity: 0.8,
    ...input,
  };
}

const moment: GameplayMomentSpecV1 = {
  schema: "gameplay_moment",
  version: 1,
  momentId: "tilt-salvage-moment",
  conceptId: "tilt-salvage",
  hypothesis: "Cutting salvage changes platform balance and forces two-player coordination.",
  durationTargetSec: 5,
  setup: "Two players stand on an unstable salvage platform.",
  playerActions: [
    {
      role: "cutter",
      action: "cuts a metal support with a held tool",
      dependencyOnOthers: "needs the teammate to stabilize the load",
    },
    {
      role: "support",
      action: "holds the load with a tether",
      dependencyOnOthers: "waits for the cutter to free the salvage",
    },
  ],
  coopDependencyEvidence: "The shared load becomes unstable if either player stops their role.",
  socialTension: "The support player must react before the load slides.",
  failureBeat: "The load and unsecured players slide when the platform tilts.",
  expectedViewerUnderstanding: "I cut, my teammate stabilizes, and a mistake can make us fall.",
  cameraIntent: "first-person player camera attached to the cutter",
  requiredVisualEvidence: ["held cutting tool", "supporting teammate", "platform tilt"],
};

const shot: ShotSpecV1 = {
  schema: "gameplay_shot",
  version: 1,
  shotId: "tilt-salvage-shot-1",
  momentId: moment.momentId,
  order: 0,
  durationSec: 5,
  purpose: "mechanic",
  actors: ["cutter", "support"],
  action: "Cutter holds the tool on a support until the load comes free and the platform reacts.",
  camera: "first-person follow attached to the cutter for the entire shot",
  environment: "stylized industrial salvage platform",
  continuity: { preserve: [] },
  expectedEvidence: ["tool foreground", "teammate tether", "physical response"],
  generationPlan: {
    keyframeRequired: true,
    imageModel: "nano-banana-2",
    videoModel: "test-video-model",
    videoMode: "image-to-video",
    aspectRatio: "9:16",
    durationSec: 5,
  },
};

describe("Gameplay Reference indexing", () => {
  it("deterministically normalizes cheap-model primitive type drift before validation", () => {
    const parsed = parseGameplayReferenceCaption(`\n\`\`\`json\n${JSON.stringify(rawCaption())}\n\`\`\``);
    expect(parsed.cameraType).toBe("first_person");
    expect(parsed.fovEstimate).toBe(90);
    expect(parsed.handsVisible).toBe(true);
    expect(parsed.crosshairVisible).toBe(false);
    expect(parsed.productionScopeFeel).toBe("AA");
    expect(parsed.visualClutter).toBe("low");
    expect(parsed.mechanicTags).toEqual(["physical_manipulation", "shared_object"]);
  });

  it("does not silently turn a cinematic camera label into valid gameplay grammar", () => {
    expect(() => parseGameplayReferenceCaption(JSON.stringify(rawCaption({ cameraType: "cinematic" })))).toThrow();
  });

  it("joins model output to trusted identity/provenance and validates the full domain spec", () => {
    const caption = parseGameplayReferenceCaption(JSON.stringify(rawCaption()));
    const spec = materializeGameplayReferenceSpec({
      identity: {
        referenceId: "gref_seed_001",
        gameId: "repo",
        gameName: "R.E.P.O.",
        mediaType: "image",
        sourceType: "official_steam_screenshot",
        sourceUrl: "https://store.steampowered.com/app/3241660/",
        observedAt: "2026-08-19T04:00:00+00:00",
        driveFileId: "drive-1",
        mimeType: "image/jpeg",
        width: 1920,
        height: 1080,
        contentSha256: "a".repeat(64),
        perceptualHash: "f0f0f0f0f0f0f0f0",
        metadata: { trusted_seed: true },
      },
      caption,
    });
    expect(spec.gameName).toBe("R.E.P.O.");
    expect(spec.gameplayDescription).toContain("First-person player");
    expect(spec.metadata).toEqual({ trusted_seed: true });
    expect(buildGameplayReferenceEmbeddingText(spec)).toContain("world_response:");
  });

  it("caption prompt explicitly separates gameplay evidence from marketing imagery", () => {
    const prompt = buildGameplayReferenceCaptionPrompt("PEAK");
    expect(prompt).toContain("REAL PC GAMEPLAY");
    expect(prompt).toContain("not key art");
    expect(prompt).toContain("Do not invent a HUD");
  });
});

describe("Gameplay Reference retrieval", () => {
  it("builds a typed need from the existing moment and shot without passing an untyped image dump", () => {
    const need = buildGameplayReferenceNeed({
      moment,
      shot,
      mechanicTags: ["physical_manipulation", "shared_object"],
      interactionModel: ["physics_coordination"],
      productionScopeFeel: ["indie", "AA"],
      requireSharedObject: true,
      requireVisibleRisk: true,
      maxResults: 6,
    });
    expect(need.cameraTypes).toContain("first_person");
    expect(need.purposes).toEqual([
      "gameplay_camera",
      "interaction",
      "coop",
      "art_direction",
    ]);
    expect(need.maxResults).toBe(6);
  });

  it("returns a small purpose-labeled, game-diverse reference set", () => {
    const need = buildGameplayReferenceNeed({
      moment,
      shot,
      mechanicTags: ["physical_manipulation", "shared_object"],
      interactionModel: ["physics_coordination"],
      productionScopeFeel: ["indie"],
      requireSharedObject: true,
      requireVisibleRisk: true,
      maxResults: 8,
    });
    const candidates = [
      candidate({ referenceId: "repo-1", gameId: "repo", gameName: "R.E.P.O.", semanticSimilarity: 0.99 }),
      candidate({ referenceId: "repo-2", gameId: "repo", gameName: "R.E.P.O.", semanticSimilarity: 0.98 }),
      candidate({ referenceId: "repo-3", gameId: "repo", gameName: "R.E.P.O.", semanticSimilarity: 0.97 }),
      candidate({ referenceId: "peak-1", gameId: "peak", gameName: "PEAK", semanticSimilarity: 0.9 }),
      candidate({ referenceId: "rv-1", gameId: "rv", gameName: "RV There Yet?", semanticSimilarity: 0.88 }),
      candidate({ referenceId: "chain-1", gameId: "chain", gameName: "Chained Together", semanticSimilarity: 0.84 }),
      candidate({ referenceId: "abiotic-1", gameId: "abiotic", gameName: "Abiotic Factor", semanticSimilarity: 0.8 }),
      candidate({ referenceId: "lethal-1", gameId: "lethal", gameName: "Lethal Company", semanticSimilarity: 0.78 }),
      candidate({ referenceId: "peak-2", gameId: "peak", gameName: "PEAK", semanticSimilarity: 0.76 }),
    ];

    const result = retrieveGameplayReferences({ need, candidates });
    expect(result.references.length).toBeLessThanOrEqual(8);
    expect(new Set(result.references.map((item) => item.purpose))).toEqual(
      new Set(["gameplay_camera", "interaction", "coop", "art_direction"]),
    );
    const perGame = result.references.reduce<Record<string, number>>((counts, item) => {
      counts[item.reference.gameId] = (counts[item.reference.gameId] ?? 0) + 1;
      return counts;
    }, {});
    expect(Math.max(...Object.values(perGame))).toBeLessThanOrEqual(2);
  });
});
