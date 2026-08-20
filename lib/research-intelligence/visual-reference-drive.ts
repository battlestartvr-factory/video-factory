import "server-only";

import { createHash } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  createDriveApiClient,
  createDriveAuthClient,
  getDriveStorageProvider,
  isDriveStorageConfigured,
} from "@/lib/storage/drive-provider";
import { createWebFetchProvider } from "@/lib/web/fetch-provider";
import type { CompiledImageReferenceAsset } from "./visual-references";

const CACHE_BUCKET = "generator-inputs";
const SIGNED_URL_TTL_SECONDS = 48 * 60 * 60;

function extensionForMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

function folderSegments(researchRunId: string, observedAt: string): string[] {
  const date = new Date(observedAt);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return [
    "Research",
    "Visual References",
    String(safeDate.getUTCFullYear()),
    String(safeDate.getUTCMonth() + 1).padStart(2, "0"),
    String(safeDate.getUTCDate()).padStart(2, "0"),
    researchRunId,
  ];
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

export interface ArchivedExternalVisualReference {
  driveFileId: string;
  driveWebUrl: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number | null;
  archivedAt: string;
}

export async function archiveExternalVisualReference(input: {
  researchRunId: string;
  referenceId: string;
  imageUrl: string;
  expectedSha256: string;
  expectedMimeType?: string;
  expectedWidth?: number;
  expectedHeight?: number;
}): Promise<ArchivedExternalVisualReference> {
  if (!isDriveStorageConfigured()) throw new Error("GOOGLE_DRIVE_NOT_CONFIGURED");
  const service = createSupabaseServiceClient();
  const { data: run, error: runError } = await service
    .from("research_runs")
    .select("id")
    .eq("id", input.researchRunId)
    .maybeSingle();
  if (runError || !run) throw new Error("RESEARCH_RUN_NOT_FOUND");

  const fetched = await createWebFetchProvider().fetchImage(input.imageUrl);
  if (fetched.contentSha256.toLowerCase() !== input.expectedSha256.toLowerCase()) {
    throw new Error("RESEARCH_VISUAL_ARCHIVE_HASH_MISMATCH");
  }
  if (input.expectedMimeType && fetched.mimeType !== input.expectedMimeType) {
    throw new Error("RESEARCH_VISUAL_ARCHIVE_MIME_MISMATCH");
  }
  if (input.expectedWidth && fetched.width !== input.expectedWidth) {
    throw new Error("RESEARCH_VISUAL_ARCHIVE_WIDTH_MISMATCH");
  }
  if (input.expectedHeight && fetched.height !== input.expectedHeight) {
    throw new Error("RESEARCH_VISUAL_ARCHIVE_HEIGHT_MISMATCH");
  }

  const filename = `external-visual-${input.referenceId}.${extensionForMime(fetched.mimeType)}`;
  const drive = getDriveStorageProvider();
  const folderId = await drive.ensureFolderPath(folderSegments(input.researchRunId, fetched.observedAt));
  const existingId = await findExistingDriveFile(folderId, filename);
  const driveFileId =
    existingId ??
    (await (async () => {
      const buffer = Buffer.from(fetched.bytes);
      const session = await drive.createResumableUpload({
        filename,
        mimeType: fetched.mimeType,
        sizeBytes: buffer.length,
        folderId,
      });
      return drive.completeResumableUpload({
        uploadUrl: session.uploadUrl,
        mimeType: fetched.mimeType,
        buffer,
      });
    })());
  const meta = await drive.finalizeUpload(driveFileId);
  return {
    driveFileId,
    driveWebUrl: meta.webViewUrl,
    filename: meta.filename || filename,
    mimeType: meta.mimeType || fetched.mimeType,
    sizeBytes: meta.sizeBytes ?? fetched.byteLength,
    archivedAt: new Date().toISOString(),
  };
}

function safeFilename(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.replace(/^-+|-+$/g, "").slice(0, 120) || "external-visual";
}

function cachePath(input: {
  referenceId: string;
  driveFileId: string;
  filename: string;
  mimeType: string;
}): string {
  const identity = createHash("sha256")
    .update(`${input.referenceId}:${input.driveFileId}`)
    .digest("hex")
    .slice(0, 24);
  const base = safeFilename(input.filename).replace(/\.[a-zA-Z0-9]{1,8}$/, "");
  return `system/external-visual-reference-cache/v1/${input.referenceId}/${identity}-${base}.${extensionForMime(input.mimeType)}`;
}

export async function materializeExternalVisualReferences(input: {
  researchRunId: string;
  referenceIds: string[];
}): Promise<CompiledImageReferenceAsset[]> {
  if (!input.referenceIds.length || input.referenceIds.length > 8) {
    throw new Error("RESEARCH_VISUAL_MATERIALIZE_REFERENCE_COUNT_INVALID");
  }
  if (new Set(input.referenceIds).size !== input.referenceIds.length) {
    throw new Error("RESEARCH_VISUAL_MATERIALIZE_DUPLICATE_ID");
  }

  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("research_assets")
    .select("id,run_id,drive_file_id,mime,roles,status,metadata")
    .eq("run_id", input.researchRunId)
    .in("id", input.referenceIds);
  if (error) throw new Error(`RESEARCH_VISUAL_MATERIALIZE_DB_FAILED:${error.message}`);
  const rows = Array.isArray(data) ? data : [];
  if (rows.length !== input.referenceIds.length) {
    throw new Error("RESEARCH_VISUAL_MATERIALIZE_LINEAGE_MISSING");
  }
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const drive = getDriveStorageProvider();
  const assets: CompiledImageReferenceAsset[] = [];

  for (const referenceId of input.referenceIds) {
    const row = byId.get(referenceId);
    const metadata =
      row?.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {};
    if (
      !row ||
      typeof row.drive_file_id !== "string" ||
      !row.drive_file_id ||
      !["selected", "archived"].includes(String(row.status)) ||
      metadata.generated_asset === true ||
      metadata.gameplay_library_entry === true
    ) {
      throw new Error(`RESEARCH_VISUAL_MATERIALIZE_LINEAGE_INVALID:${referenceId}`);
    }
    const file = await drive.getFileMetadata(row.drive_file_id);
    if (!file.mimeType.startsWith("image/")) {
      throw new Error(`RESEARCH_VISUAL_MATERIALIZE_MIME_INVALID:${referenceId}`);
    }
    const buffer = await drive.downloadFile(row.drive_file_id);
    const path = cachePath({
      referenceId,
      driveFileId: row.drive_file_id,
      filename: file.filename,
      mimeType: file.mimeType,
    });
    const { error: uploadError } = await service.storage.from(CACHE_BUCKET).upload(path, buffer, {
      contentType: file.mimeType,
      cacheControl: "3600",
      upsert: true,
    });
    if (uploadError) {
      throw new Error(`RESEARCH_VISUAL_MATERIALIZE_CACHE_UPLOAD_FAILED:${uploadError.message}`);
    }
    const { data: signed, error: signedError } = await service.storage
      .from(CACHE_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (signedError || !signed?.signedUrl) {
      throw new Error(
        `RESEARCH_VISUAL_MATERIALIZE_SIGNED_URL_FAILED:${signedError?.message ?? referenceId}`,
      );
    }
    const roles = Array.isArray(row.roles) ? row.roles.filter((value): value is string => typeof value === "string") : [];
    assets.push({
      id: referenceId,
      url: signed.signedUrl,
      mimeType: file.mimeType,
      filename: file.filename,
      role: roles[0] ?? "external_research",
      origin: "external_research",
    });
  }

  return assets;
}
