import "server-only";

import { createReadStream } from "node:fs";
import { resolve, sep } from "node:path";
import { stat } from "node:fs/promises";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  createDriveApiClient,
  createDriveAuthClient,
  getDriveStorageProvider,
  isDriveStorageConfigured,
} from "@/lib/storage/drive-provider";

const DEFAULT_DATA_ROOT = "/srv/ai-factory";
const STAGING_FOLDER = "discovery-assembly-staging";

export type DiscoveryAssemblyVariant = "landscape_master" | "vertical_social";

export interface ArchivedDiscoveryAssembly {
  driveFileId: string;
  driveWebUrl: string | null;
  filename: string;
  mimeType: "video/mp4";
  sizeBytes: number;
  archivedAt: string;
}

function dataRoot(): string {
  return (process.env.AI_FACTORY_DATA_ROOT ?? DEFAULT_DATA_ROOT).trim() || DEFAULT_DATA_ROOT;
}

function resolveStagedFile(relativePath: string): string {
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\0")) {
    throw new Error("ASSEMBLY_ARCHIVE_INVALID_PATH");
  }
  const root = resolve(/* turbopackIgnore: true */ dataRoot());
  const allowedRoot = resolve(root, STAGING_FOLDER);
  const filePath = resolve(root, relativePath);
  if (filePath !== allowedRoot && !filePath.startsWith(`${allowedRoot}${sep}`)) {
    throw new Error("ASSEMBLY_ARCHIVE_INVALID_PATH");
  }
  return filePath;
}

function folderSegments(createdAt: string): string[] {
  const date = new Date(createdAt);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return [
    "Generated",
    "Discovery Shorts",
    String(safeDate.getUTCFullYear()),
    String(safeDate.getUTCMonth() + 1).padStart(2, "0"),
    String(safeDate.getUTCDate()).padStart(2, "0"),
  ];
}

function artifactFilename(input: {
  variant: DiscoveryAssemblyVariant;
  conceptRunId: string;
  sourceVideoId: string;
}): string {
  return input.variant === "landscape_master"
    ? `gameplay-master-16x9-v1-${input.conceptRunId}-${input.sourceVideoId}.mp4`
    : `social-edit-9x16-v1-${input.conceptRunId}-${input.sourceVideoId}.mp4`;
}

async function findExistingDriveFile(folderId: string, filename: string): Promise<string | null> {
  const auth = createDriveAuthClient();
  if (!auth) return null;
  const drive = createDriveApiClient(auth);
  const escaped = filename.replace(/'/g, "\\'");
  const response = await drive.files.list({
    q: `'${folderId}' in parents and name='${escaped}' and trashed=false`,
    fields: "files(id)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return response.data.files?.[0]?.id ?? null;
}

async function completeUploadFromFile(input: {
  uploadUrl: string;
  filePath: string;
  sizeBytes: number;
}): Promise<string> {
  const response = await fetch(input.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(input.sizeBytes),
    },
    body: createReadStream(/* turbopackIgnore: true */ input.filePath) as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!response.ok) throw new Error(`ASSEMBLY_DRIVE_UPLOAD_FAILED:${response.status}`);
  const body = (await response.json()) as { id?: string };
  if (!body.id) throw new Error("ASSEMBLY_DRIVE_FILE_ID_MISSING");
  return body.id;
}

export async function archiveDiscoveryAssembly(input: {
  rootCreativeRunId: string;
  conceptRunId: string;
  conceptId: string;
  variant: DiscoveryAssemblyVariant;
  artifactRelativePath: string;
  inputVideoGenerationIds: string[];
  sha256: string;
}): Promise<ArchivedDiscoveryAssembly> {
  if (!isDriveStorageConfigured()) throw new Error("GOOGLE_DRIVE_NOT_CONFIGURED");
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error("ASSEMBLY_ARCHIVE_INVALID_SHA256");
  if (input.inputVideoGenerationIds.length !== 1 || !input.inputVideoGenerationIds[0]) {
    throw new Error("ASSEMBLY_ARCHIVE_VIDEO_ID_REQUIRED");
  }
  if (input.variant !== "landscape_master" && input.variant !== "vertical_social") {
    throw new Error("ASSEMBLY_ARCHIVE_VARIANT_INVALID");
  }

  const service = createSupabaseServiceClient();
  const [rootResult, conceptResult] = await Promise.all([
    service
      .from("creative_runs")
      .select("id,created_at,metadata")
      .eq("id", input.rootCreativeRunId)
      .contains("metadata", { domain_kind: "game_discovery_batch" })
      .maybeSingle(),
    service
      .from("creative_runs")
      .select("id,parent_run_id,metadata")
      .eq("id", input.conceptRunId)
      .eq("parent_run_id", input.rootCreativeRunId)
      .contains("metadata", { domain_kind: "coop_game_concept" })
      .maybeSingle(),
  ]);
  if (rootResult.error || !rootResult.data) throw new Error("DISCOVERY_ASSEMBLY_ROOT_NOT_FOUND");
  if (conceptResult.error || !conceptResult.data) throw new Error("DISCOVERY_ASSEMBLY_CONCEPT_NOT_FOUND");
  if (conceptResult.data.metadata?.concept_id !== input.conceptId) {
    throw new Error("DISCOVERY_ASSEMBLY_CONCEPT_MISMATCH");
  }

  const filePath = resolveStagedFile(input.artifactRelativePath);
  const fileStat = await stat(/* turbopackIgnore: true */ filePath);
  if (!fileStat.isFile() || fileStat.size <= 0) throw new Error("ASSEMBLY_ARCHIVE_FILE_EMPTY");

  const drive = getDriveStorageProvider();
  const folderId = await drive.ensureFolderPath(folderSegments(rootResult.data.created_at));
  const sourceVideoId = input.inputVideoGenerationIds[0];
  const filename = artifactFilename({
    variant: input.variant,
    conceptRunId: input.conceptRunId,
    sourceVideoId,
  });
  const existingId = await findExistingDriveFile(folderId, filename);
  if (existingId) {
    const meta = await drive.finalizeUpload(existingId);
    return {
      driveFileId: existingId,
      driveWebUrl: meta.webViewUrl,
      filename: meta.filename || filename,
      mimeType: "video/mp4",
      sizeBytes: meta.sizeBytes ?? fileStat.size,
      archivedAt: new Date().toISOString(),
    };
  }

  const session = await drive.createResumableUpload({
    filename,
    mimeType: "video/mp4",
    sizeBytes: fileStat.size,
    folderId,
  });
  const driveFileId = await completeUploadFromFile({
    uploadUrl: session.uploadUrl,
    filePath,
    sizeBytes: fileStat.size,
  });
  const meta = await drive.finalizeUpload(driveFileId);
  return {
    driveFileId,
    driveWebUrl: meta.webViewUrl,
    filename: meta.filename || filename,
    mimeType: "video/mp4",
    sizeBytes: meta.sizeBytes ?? fileStat.size,
    archivedAt: new Date().toISOString(),
  };
}