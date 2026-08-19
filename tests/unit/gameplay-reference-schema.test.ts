import { describe, expect, it, vi } from "vitest";
import {
  gameplayReferencePurposeSchema,
  gameplayReferenceSpecV1Schema,
} from "../../lib/game-discovery/gameplay-reference-schema";
import type { DriveStorageProvider } from "../../lib/storage/drive-provider";
import {
  GAMEPLAY_REFERENCE_SEED_GAMES_V1,
  ensureGameplayReferenceLibraryHierarchy,
  resolveGameplayReferenceMediaFolderSegments,
} from "../../lib/storage/gameplay-reference-library";

function validImageReference() {
  return {
    schema: "gameplay_reference" as const,
    version: 1 as const,
    referenceId: "gref_repo_001",
    gameId: "repo",
    gameName: "R.E.P.O.",
    mediaType: "image" as const,
    sourceType: "official_steam_screenshot" as const,
    sourceUrl: "https://store.steampowered.com/app/3241660/",
    observedAt: "2026-08-19T04:00:00+00:00",
    driveFileId: "drive-file-1",
    mimeType: "image/jpeg",
    width: 1920,
    height: 1080,
    cameraType: "first_person" as const,
    cameraDistance: "player eye level at interaction distance",
    cameraHeight: "standing eye height",
    fovEstimate: 90,
    playableCharacterVisible: false,
    handsVisible: true,
    heldToolVisible: true,
    crosshairVisible: false,
    hudVisible: true,
    controllablePlayerObvious: true,
    howPlayerControlIsVisible: "The held grab tool occupies the foreground and is aimed by the camera.",
    currentPlayerAction: "The player is pulling a heavy object through a doorway.",
    visibleInputAffordance: "Held tool and object-state HUD.",
    playerTarget: "Heavy cabinet in the doorway.",
    gameResponse: "The cabinet rotates and catches on the door frame while the teammate counter-pulls.",
    teammateCountVisible: 1,
    teammateDistance: "A few meters away on the opposite side of the object.",
    teammateRole: "Counter-pulls the same shared object.",
    coopDependencyVisible: true,
    sharedObjectVisible: true,
    informationAsymmetryVisible: false,
    rescueVisible: false,
    coordinationVisible: true,
    coreAction: "Two players manipulate one heavy object.",
    mechanicTags: ["physical_manipulation", "shared_object"],
    interactionModel: ["physics_coordination"],
    dangerSource: "Narrow doorway and unstable object motion.",
    failureRisk: "The object can collide with the environment or be dropped.",
    successState: "The object clears the doorway intact.",
    physicsInteraction: "Shared rigid-body manipulation.",
    environmentType: "Interior corridor",
    primaryFocus: "Held tool connected to the heavy object.",
    secondaryFocus: "Teammate pulling from the far side.",
    readableWithoutContext: true,
    visibleGoal: true,
    visibleRisk: true,
    uiSupportsAction: true,
    visualClutter: "low" as const,
    artDirection: "Stylized low-detail industrial horror co-op.",
    realismLevel: "stylized",
    productionScopeFeel: "indie" as const,
    stylizationTags: ["chunky_shapes", "simple_materials"],
    gameplayDescription:
      "First-person player aims a held grab tool at a heavy cabinet and pulls it through a narrow doorway while one teammate counter-pulls from the far side; the object-state HUD and collision with the frame make the action and risk immediately legible.",
    whyThisLooksLikeGameplay:
      "The camera belongs to the player, the controlled tool fills the foreground, the teammate stays at playable distance, and the world reacts directly to the visible manipulation.",
    contentSha256: "a".repeat(64),
    perceptualHash: "f0f0f0f0f0f0f0f0",
    metadata: { seed: true },
  };
}

describe("Gameplay Reference Library v1 foundation", () => {
  it("validates a concrete real-gameplay image reference", () => {
    const parsed = gameplayReferenceSpecV1Schema.parse(validImageReference());
    expect(parsed.referenceId).toBe("gref_repo_001");
    expect(parsed.gameplayDescription).toContain("First-person player");
    expect(parsed.coopDependencyVisible).toBe(true);
  });

  it("requires duration only for video segments and prevents self-canonicalization", () => {
    expect(
      gameplayReferenceSpecV1Schema.safeParse({
        ...validImageReference(),
        mediaType: "video_segment",
      }).success,
    ).toBe(false);

    expect(
      gameplayReferenceSpecV1Schema.safeParse({
        ...validImageReference(),
        durationMs: 5_000,
      }).success,
    ).toBe(false);

    expect(
      gameplayReferenceSpecV1Schema.safeParse({
        ...validImageReference(),
        canonicalReferenceId: "gref_repo_001",
      }).success,
    ).toBe(false);

    expect(
      gameplayReferenceSpecV1Schema.parse({
        ...validImageReference(),
        mediaType: "video_segment",
        mimeType: "video/mp4",
        driveFileId: "drive-video-1",
        referenceId: "gref_repo_clip_001",
        durationMs: 5_000,
      }).durationMs,
    ).toBe(5_000);
  });

  it("fixes the four reference purposes as distinct typed roles", () => {
    expect(gameplayReferencePurposeSchema.options).toEqual([
      "gameplay_camera",
      "interaction",
      "coop",
      "art_direction",
    ]);
  });

  it("defines the ten requested seed games without hard-coding architecture to them", () => {
    expect(GAMEPLAY_REFERENCE_SEED_GAMES_V1).toHaveLength(10);
    expect(GAMEPLAY_REFERENCE_SEED_GAMES_V1).toContain("Lethal Company");
    expect(GAMEPLAY_REFERENCE_SEED_GAMES_V1).toContain("Abiotic Factor");

    expect(resolveGameplayReferenceMediaFolderSegments("Future Game", "Screenshots")).toEqual([
      "References",
      "Gameplay",
      "Games",
      "Future Game",
      "Screenshots",
    ]);
  });

  it("materializes the Drive hierarchy idempotently through the existing storage provider contract", async () => {
    const ensureFolderPath = vi.fn(async (segments: string[]) => `id:${segments.join("/")}`);
    const provider = {
      authMode: "service_account" as const,
      isConfigured: () => true,
      ensureFolderPath,
      createResumableUpload: vi.fn(),
      completeResumableUpload: vi.fn(),
      finalizeUpload: vi.fn(),
      downloadFile: vi.fn(),
      deleteFile: vi.fn(),
      getFileMetadata: vi.fn(),
    } satisfies DriveStorageProvider;

    const hierarchy = await ensureGameplayReferenceLibraryHierarchy({
      provider,
      games: ["R.E.P.O.", "PEAK"],
    });

    expect(hierarchy.gameplayRootFolderId).toBe("id:References/Gameplay");
    expect(hierarchy.games["R.E.P.O."].screenshotsFolderId).toBe(
      "id:References/Gameplay/Games/R.E.P.O./Screenshots",
    );
    expect(hierarchy.games.PEAK.gameplayClipsFolderId).toBe(
      "id:References/Gameplay/Games/PEAK/Gameplay Clips",
    );
    expect(ensureFolderPath).toHaveBeenCalledWith([
      "References",
      "Gameplay",
      "Games",
      "R.E.P.O.",
      "Other References",
    ]);
  });

  it("rejects unsafe Drive folder segments", () => {
    expect(() =>
      resolveGameplayReferenceMediaFolderSegments("../bad/game", "Screenshots"),
    ).toThrow("GAME_NAME_INVALID");
  });
});
