import "server-only";
import type { DriveStorageProvider } from "@/lib/storage/drive-provider";
import { getDriveStorageProvider } from "@/lib/storage/drive-provider";

export const GAMEPLAY_REFERENCE_LIBRARY_ROOT_SEGMENTS = [
  "References",
  "Gameplay",
] as const;

export const GAMEPLAY_REFERENCE_SEED_GAMES_V1 = [
  "Lethal Company",
  "R.E.P.O.",
  "PEAK",
  "Shift At Midnight",
  "Content Warning",
  "Phasmophobia",
  "Chained Together",
  "RV There Yet?",
  "Valheim",
  "Abiotic Factor",
] as const;

export const GAMEPLAY_REFERENCE_MEDIA_FOLDERS = [
  "Screenshots",
  "Gameplay Clips",
  "Other References",
] as const;

export type GameplayReferenceMediaFolder =
  (typeof GAMEPLAY_REFERENCE_MEDIA_FOLDERS)[number];

function validateFolderSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label.toUpperCase()}_EMPTY`);
  if (normalized === "." || normalized === ".." || normalized.includes("/")) {
    throw new Error(`${label.toUpperCase()}_INVALID`);
  }
  return normalized;
}

export function resolveGameplayReferenceGameFolderSegments(gameName: string): string[] {
  return [
    ...GAMEPLAY_REFERENCE_LIBRARY_ROOT_SEGMENTS,
    "Games",
    validateFolderSegment(gameName, "game_name"),
  ];
}

export function resolveGameplayReferenceMediaFolderSegments(
  gameName: string,
  mediaFolder: GameplayReferenceMediaFolder,
): string[] {
  return [
    ...resolveGameplayReferenceGameFolderSegments(gameName),
    mediaFolder,
  ];
}

export interface GameplayReferenceGameFolderIds {
  gameFolderId: string;
  screenshotsFolderId: string;
  gameplayClipsFolderId: string;
  otherReferencesFolderId: string;
}

export interface GameplayReferenceLibraryHierarchy {
  gameplayRootFolderId: string;
  gamesFolderId: string;
  games: Record<string, GameplayReferenceGameFolderIds>;
}

export async function ensureGameplayReferenceLibraryHierarchy(input?: {
  provider?: DriveStorageProvider;
  games?: readonly string[];
}): Promise<GameplayReferenceLibraryHierarchy> {
  const provider = input?.provider ?? getDriveStorageProvider();
  const games = input?.games ?? GAMEPLAY_REFERENCE_SEED_GAMES_V1;

  const gameplayRootFolderId = await provider.ensureFolderPath([
    ...GAMEPLAY_REFERENCE_LIBRARY_ROOT_SEGMENTS,
  ]);
  const gamesFolderId = await provider.ensureFolderPath([
    ...GAMEPLAY_REFERENCE_LIBRARY_ROOT_SEGMENTS,
    "Games",
  ]);

  const result: GameplayReferenceLibraryHierarchy = {
    gameplayRootFolderId,
    gamesFolderId,
    games: {},
  };

  for (const rawGameName of games) {
    const gameName = validateFolderSegment(rawGameName, "game_name");
    const gameSegments = resolveGameplayReferenceGameFolderSegments(gameName);
    const gameFolderId = await provider.ensureFolderPath(gameSegments);
    const screenshotsFolderId = await provider.ensureFolderPath([
      ...gameSegments,
      "Screenshots",
    ]);
    const gameplayClipsFolderId = await provider.ensureFolderPath([
      ...gameSegments,
      "Gameplay Clips",
    ]);
    const otherReferencesFolderId = await provider.ensureFolderPath([
      ...gameSegments,
      "Other References",
    ]);

    result.games[gameName] = {
      gameFolderId,
      screenshotsFolderId,
      gameplayClipsFolderId,
      otherReferencesFolderId,
    };
  }

  return result;
}
