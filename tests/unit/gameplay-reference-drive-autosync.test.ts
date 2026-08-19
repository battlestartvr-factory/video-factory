import { describe, expect, it } from "vitest";
import {
  gameplayReferenceGameIdFromFolderName,
  gameplayReferenceIdFromDriveFileId,
  isSupportedGameplayReferenceImageMime,
} from "../../lib/game-discovery/gameplay-reference-drive-sync";
import { gameplayReferenceSourceTypeSchema } from "../../lib/game-discovery/gameplay-reference-schema";

describe("Gameplay Reference Drive Auto-Sync v1", () => {
  it("assigns stable reference ids from Drive file ids", () => {
    const first = gameplayReferenceIdFromDriveFileId("drive-file-abc");
    expect(first).toMatch(/^gref_drive_[a-f0-9]{24}$/);
    expect(gameplayReferenceIdFromDriveFileId("drive-file-abc")).toBe(first);
    expect(gameplayReferenceIdFromDriveFileId("drive-file-def")).not.toBe(first);
  });

  it("creates stable architecture-independent ids for newly added game folders", () => {
    const first = gameplayReferenceGameIdFromFolderName("Future Co-op Game");
    expect(first).toMatch(/^drive-future-co-op-game-[a-f0-9]{8}$/);
    expect(gameplayReferenceGameIdFromFolderName("Future Co-op Game")).toBe(first);
  });

  it("only auto-indexes image formats supported by the cheap caption path", () => {
    expect(isSupportedGameplayReferenceImageMime("image/jpeg")).toBe(true);
    expect(isSupportedGameplayReferenceImageMime("image/png")).toBe(true);
    expect(isSupportedGameplayReferenceImageMime("image/webp")).toBe(true);
    expect(isSupportedGameplayReferenceImageMime("image/gif")).toBe(false);
    expect(isSupportedGameplayReferenceImageMime("video/mp4")).toBe(false);
  });

  it("classifies manual Drive uploads without requiring human source provenance", () => {
    expect(gameplayReferenceSourceTypeSchema.parse("manual_drive_upload")).toBe(
      "manual_drive_upload",
    );
  });
});
