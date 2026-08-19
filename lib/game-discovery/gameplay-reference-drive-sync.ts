import "server-only";
import { createHash } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  createDriveApiClient,
  createDriveAuthClient,
  getDriveStorageProvider,
} from "@/lib/storage/drive-provider";
import { GAMEPLAY_REFERENCE_LIBRARY_ROOT_SEGMENTS } from "@/lib/storage/gameplay-reference-library";

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DEFAULT_MAX_NEW_FILES = 8;
const MAX_NEW_FILES = 32;

interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string | null;
  createdTime: string | null;
  modifiedTime: string | null;
  width: number | null;
  height: number | null;
}

interface DriveImageCandidate extends DriveEntry {
  gameName: string;
  screenshotsFolderId: string;
}

export interface GameplayReferenceDriveSyncResult {
  gamesScanned: number;
  imagesScanned: number;
  discovered: number;
  registered: number;
  alreadyRegistered: number;
  exactDuplicates: number;
  unsupported: number;
  waitingForMetadata: number;
  failed: number;
  indexJobsEnqueued: number;
  activeJobsAlreadyPresent: number;
}

function normalizedPositiveInt(value: unknown): number | null {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return null;
  return Math.trunc(numberValue);
}

function normalizeSyncLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_NEW_FILES;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_NEW_FILES);
}

export function gameplayReferenceIdFromDriveFileId(driveFileId: string): string {
  const digest = createHash("sha256").update(driveFileId).digest("hex").slice(0, 24);
  return `gref_drive_${digest}`;
}

export function gameplayReferenceGameIdFromFolderName(gameName: string): string {
  const slug = gameName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  const digest = createHash("sha256")
    .update(gameName.trim().toLowerCase())
    .digest("hex")
    .slice(0, 8);
  return `drive-${slug || "game"}-${digest}`;
}

export function isSupportedGameplayReferenceImageMime(mimeType: string): boolean {
  return SUPPORTED_IMAGE_MIMES.has(mimeType.toLowerCase());
}

function driveSourceUrl(file: DriveEntry): string {
  return file.webViewLink ?? `https://drive.google.com/open?id=${encodeURIComponent(file.id)}`;
}

async function listDriveChildren(folderId: string): Promise<DriveEntry[]> {
  const auth = createDriveAuthClient();
  if (!auth) throw new Error("GAMEPLAY_REFERENCE_DRIVE_SYNC_NOT_CONFIGURED");
  const drive = createDriveApiClient(auth);
  const entries: DriveEntry[] = [];
  let pageToken: string | undefined;

  do {
    const response = await drive.files.list({
      q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed=false`,
      fields:
        "nextPageToken,files(id,name,mimeType,webViewLink,createdTime,modifiedTime,imageMediaMetadata(width,height))",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    for (const file of response.data.files ?? []) {
      if (!file.id || !file.name || !file.mimeType) continue;
      entries.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        webViewLink: file.webViewLink ?? null,
        createdTime: file.createdTime ?? null,
        modifiedTime: file.modifiedTime ?? null,
        width: normalizedPositiveInt(file.imageMediaMetadata?.width),
        height: normalizedPositiveInt(file.imageMediaMetadata?.height),
      });
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return entries;
}

async function discoverDriveImages(): Promise<{
  gamesScanned: number;
  images: DriveImageCandidate[];
}> {
  const provider = getDriveStorageProvider();
  const gamesFolderId = await provider.ensureFolderPath([
    ...GAMEPLAY_REFERENCE_LIBRARY_ROOT_SEGMENTS,
    "Games",
  ]);
  const gameFolders = (await listDriveChildren(gamesFolderId)).filter(
    (entry) => entry.mimeType === DRIVE_FOLDER_MIME,
  );
  const images: DriveImageCandidate[] = [];

  for (const gameFolder of gameFolders) {
    const children = await listDriveChildren(gameFolder.id);
    const screenshotsFolder = children.find(
      (entry) => entry.mimeType === DRIVE_FOLDER_MIME && entry.name === "Screenshots",
    );
    if (!screenshotsFolder) continue;

    const screenshotFiles = await listDriveChildren(screenshotsFolder.id);
    for (const file of screenshotFiles) {
      if (file.mimeType === DRIVE_FOLDER_MIME) continue;
      images.push({
        ...file,
        gameName: gameFolder.name.trim(),
        screenshotsFolderId: screenshotsFolder.id,
      });
    }
  }

  images.sort((left, right) => {
    const leftTime = left.createdTime ?? left.modifiedTime ?? "";
    const rightTime = right.createdTime ?? right.modifiedTime ?? "";
    return leftTime.localeCompare(rightTime) || left.id.localeCompare(right.id);
  });

  return { gamesScanned: gameFolders.length, images };
}

async function ensureGameId(gameName: string): Promise<string> {
  const supabase = createSupabaseServiceClient();
  const { data: games, error: readError } = await supabase
    .from("gameplay_reference_games")
    .select("game_id,game_name");
  if (readError) throw new Error(`GAMEPLAY_REFERENCE_GAME_QUERY_FAILED:${readError.message}`);

  const existing = (games ?? []).find(
    (game) => String(game.game_name).trim().toLowerCase() === gameName.trim().toLowerCase(),
  );
  if (existing) return String(existing.game_id);

  const gameId = gameplayReferenceGameIdFromFolderName(gameName);
  const { error: insertError } = await supabase.from("gameplay_reference_games").insert({
    game_id: gameId,
    game_name: gameName,
    metadata: { discovered_by: "drive_auto_sync" },
  });
  if (insertError) {
    const { data: retryGames, error: retryError } = await supabase
      .from("gameplay_reference_games")
      .select("game_id,game_name");
    if (retryError) throw new Error(`GAMEPLAY_REFERENCE_GAME_INSERT_FAILED:${insertError.message}`);
    const raced = (retryGames ?? []).find(
      (game) => String(game.game_name).trim().toLowerCase() === gameName.trim().toLowerCase(),
    );
    if (raced) return String(raced.game_id);
    throw new Error(`GAMEPLAY_REFERENCE_GAME_INSERT_FAILED:${insertError.message}`);
  }
  return gameId;
}

async function recordIngest(input: {
  file: DriveImageCandidate;
  status: "registered" | "already_registered" | "exact_duplicate" | "unsupported" | "failed";
  referenceId?: string | null;
  canonicalReferenceId?: string | null;
  contentSha256?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const supabase = createSupabaseServiceClient();
  const { error } = await supabase.from("gameplay_reference_drive_ingest").upsert(
    {
      drive_file_id: input.file.id,
      game_name: input.file.gameName,
      filename: input.file.name,
      mime_type: input.file.mimeType,
      status: input.status,
      reference_id: input.referenceId ?? null,
      canonical_reference_id: input.canonicalReferenceId ?? null,
      content_sha256: input.contentSha256 ?? null,
      error: input.error ?? null,
      metadata: {
        screenshots_folder_id: input.file.screenshotsFolderId,
        drive_created_at: input.file.createdTime,
        drive_modified_at: input.file.modifiedTime,
        ...input.metadata,
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "drive_file_id" },
  );
  if (error) throw new Error(`GAMEPLAY_REFERENCE_DRIVE_LEDGER_WRITE_FAILED:${error.message}`);
}

async function enqueuePendingDriveReferences(limit: number): Promise<{
  enqueued: number;
  active: number;
}> {
  const supabase = createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("gameplay_reference_drive_ingest")
    .select("reference_id")
    .eq("status", "registered")
    .not("reference_id", "is", null)
    .order("updated_at", { ascending: true })
    .limit(Math.max(limit * 2, 8));
  if (error) throw new Error(`GAMEPLAY_REFERENCE_PENDING_DRIVE_QUERY_FAILED:${error.message}`);

  let enqueued = 0;
  let active = 0;
  for (const row of data ?? []) {
    const referenceId = typeof row.reference_id === "string" ? row.reference_id : "";
    if (!referenceId) continue;
    const { data: rpcResult, error: enqueueError } = await supabase.rpc(
      "gameplay_reference_enqueue_index_v1",
      { p_reference_id: referenceId },
    );
    if (enqueueError) {
      throw new Error(`GAMEPLAY_REFERENCE_INDEX_ENQUEUE_FAILED:${enqueueError.message}`);
    }
    const payload =
      rpcResult && typeof rpcResult === "object" && !Array.isArray(rpcResult)
        ? (rpcResult as Record<string, unknown>)
        : {};
    if (payload.enqueued === true) enqueued += 1;
    if (payload.reason === "active_job_exists") active += 1;
  }
  return { enqueued, active };
}

export async function syncGameplayReferenceDrive(input?: {
  maxNewFiles?: number;
}): Promise<GameplayReferenceDriveSyncResult> {
  const maxNewFiles = normalizeSyncLimit(input?.maxNewFiles);
  const discovery = await discoverDriveImages();
  const supabase = createSupabaseServiceClient();
  const result: GameplayReferenceDriveSyncResult = {
    gamesScanned: discovery.gamesScanned,
    imagesScanned: discovery.images.length,
    discovered: 0,
    registered: 0,
    alreadyRegistered: 0,
    exactDuplicates: 0,
    unsupported: 0,
    waitingForMetadata: 0,
    failed: 0,
    indexJobsEnqueued: 0,
    activeJobsAlreadyPresent: 0,
  };

  const { data: ledgerRows, error: ledgerError } = await supabase
    .from("gameplay_reference_drive_ingest")
    .select("drive_file_id");
  if (ledgerError) {
    throw new Error(`GAMEPLAY_REFERENCE_DRIVE_LEDGER_QUERY_FAILED:${ledgerError.message}`);
  }
  const knownDriveFiles = new Set((ledgerRows ?? []).map((row) => String(row.drive_file_id)));
  const candidates = discovery.images.filter((file) => !knownDriveFiles.has(file.id));
  result.discovered = candidates.length;

  // Backfill the ledger for the trusted seed and any files registered by another ingest path.
  // These never consume the max-new budget and never call a model.
  const { data: registeredRows, error: registeredRowsError } = await supabase
    .from("gameplay_references")
    .select("drive_file_id,reference_id");
  if (registeredRowsError) {
    throw new Error(`GAMEPLAY_REFERENCE_EXISTING_FILE_QUERY_FAILED:${registeredRowsError.message}`);
  }
  const registeredByDriveFile = new Map(
    (registeredRows ?? []).map((row) => [String(row.drive_file_id), String(row.reference_id)]),
  );

  const newCandidates: DriveImageCandidate[] = [];
  for (const file of candidates) {
    const existingReferenceId = registeredByDriveFile.get(file.id);
    if (!existingReferenceId) {
      newCandidates.push(file);
      continue;
    }
    await recordIngest({
      file,
      status: "already_registered",
      referenceId: existingReferenceId,
    });
    result.alreadyRegistered += 1;
  }

  let processed = 0;
  for (const file of newCandidates) {
    if (processed >= maxNewFiles) break;

    if (!isSupportedGameplayReferenceImageMime(file.mimeType)) {
      await recordIngest({ file, status: "unsupported", error: "unsupported_image_mime" });
      result.unsupported += 1;
      processed += 1;
      continue;
    }

    if (!file.width || !file.height) {
      // Google Drive can briefly omit imageMediaMetadata immediately after upload.
      // Do not write a terminal ledger row; the next periodic scan will retry for free.
      result.waitingForMetadata += 1;
      continue;
    }

    try {
      const buffer = await getDriveStorageProvider().downloadFile(file.id);
      const contentSha256 = createHash("sha256").update(buffer).digest("hex");
      const { data: exactDuplicate, error: duplicateError } = await supabase
        .from("gameplay_references")
        .select("reference_id,canonical_reference_id")
        .eq("content_sha256", contentSha256)
        .limit(1)
        .maybeSingle();
      if (duplicateError) {
        throw new Error(`GAMEPLAY_REFERENCE_EXACT_DEDUPE_QUERY_FAILED:${duplicateError.message}`);
      }
      if (exactDuplicate?.reference_id) {
        const canonicalReferenceId =
          typeof exactDuplicate.canonical_reference_id === "string"
            ? exactDuplicate.canonical_reference_id
            : String(exactDuplicate.reference_id);
        await recordIngest({
          file,
          status: "exact_duplicate",
          canonicalReferenceId,
          contentSha256,
        });
        result.exactDuplicates += 1;
        processed += 1;
        continue;
      }

      const gameId = await ensureGameId(file.gameName);
      const referenceId = gameplayReferenceIdFromDriveFileId(file.id);
      const now = new Date().toISOString();
      const { error: insertError } = await supabase.from("gameplay_references").insert({
        reference_id: referenceId,
        schema_version: 1,
        game_id: gameId,
        game_name: file.gameName,
        media_type: "image",
        source_type: "manual_drive_upload",
        source_url: driveSourceUrl(file),
        source_timestamp_ms: null,
        captured_at: null,
        observed_at: now,
        drive_file_id: file.id,
        mime_type: file.mimeType,
        width: file.width,
        height: file.height,
        duration_ms: null,
        content_sha256: contentSha256,
        perceptual_hash: null,
        canonical_reference_id: null,
        dedupe_reason: null,
        metadata: {
          provenance: "manual_drive_upload",
          original_source_url: null,
          original_filename: file.name,
          screenshots_folder_id: file.screenshotsFolderId,
          drive_created_at: file.createdTime,
          drive_modified_at: file.modifiedTime,
          auto_sync_version: 1,
        },
        index_status: "pending_caption",
        index_error: null,
      });
      if (insertError) {
        throw new Error(`GAMEPLAY_REFERENCE_DRIVE_REGISTER_FAILED:${insertError.message}`);
      }

      await recordIngest({
        file,
        status: "registered",
        referenceId,
        contentSha256,
      });
      result.registered += 1;
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordIngest({
        file,
        status: "failed",
        error: message.slice(0, 2_000),
      }).catch(() => undefined);
      result.failed += 1;
      processed += 1;
    }
  }

  const queued = await enqueuePendingDriveReferences(maxNewFiles);
  result.indexJobsEnqueued = queued.enqueued;
  result.activeJobsAlreadyPresent = queued.active;
  return result;
}
