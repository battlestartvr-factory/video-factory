import "server-only";

import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  createDriveApiClient,
  createDriveAuthClient,
  getDriveStorageProvider,
  isDriveStorageConfigured,
} from "@/lib/storage/drive-provider";
import { validateWebFetchUrl } from "@/lib/web/url-safety";

const MAX_REDIRECTS = 4;
const UPSTREAM_TIMEOUT_MS = 5 * 60_000;
const STAGING_DIR = "generation-archive-staging";

export interface ArchivedGenerationOutput {
  url: string;
  providerUrl: string;
  kind: "image" | "video";
  mimeType: string;
  storageProvider: "google_drive";
  driveFileId: string;
  driveWebUrl: string | null;
  filename: string;
  sizeBytes: number | null;
  archivedAt: string;
}

function safeExtension(contentType: string, rawUrl: string, kind: "image" | "video"): string {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase();
  const byType: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  };
  if (normalized && byType[normalized]) return byType[normalized]!;
  try {
    const match = new URL(rawUrl).pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
    if (match?.[1]) return match[1].toLowerCase();
  } catch {
    // URL validation happens before this helper is used.
  }
  return kind === "video" ? "mp4" : "png";
}

function folderSegments(kind: "image" | "video", createdAt: string): string[] {
  const date = new Date(createdAt);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = String(safeDate.getUTCFullYear());
  const month = String(safeDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(safeDate.getUTCDate()).padStart(2, "0");
  return ["Generated", kind === "video" ? "Videos" : "Images", year, month, day];
}

async function fetchProviderMedia(rawUrl: string): Promise<Response> {
  let current = await validateWebFetchUrl(rawUrl);
  if (current.protocol !== "https:") throw new Error("generation_archive_requires_https");

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "*/*", "User-Agent": "AI-Content-Factory/1.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new Error("generation_archive_redirect_failed");
      }
      current = await validateWebFetchUrl(new URL(location, current).toString());
      if (current.protocol !== "https:") throw new Error("generation_archive_requires_https");
      continue;
    }
    return response;
  }
  throw new Error("generation_archive_upstream_unavailable");
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
  mimeType: string;
  sizeBytes: number;
}): Promise<string> {
  const file = await import("node:fs").then(({ createReadStream }) => createReadStream(input.filePath));
  const response = await fetch(input.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": input.mimeType,
      "Content-Length": String(input.sizeBytes),
    },
    body: file as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  if (!response.ok) {
    throw new Error(`generation_archive_drive_upload_failed:${response.status}`);
  }
  const body = (await response.json()) as { id?: string };
  if (!body.id) throw new Error("generation_archive_drive_file_id_missing");
  return body.id;
}

export async function archiveGenerationOutput(input: {
  generationId: string;
  outputIndex: number;
  sourceUrl: string;
  kind: "image" | "video";
}): Promise<ArchivedGenerationOutput> {
  if (!isDriveStorageConfigured()) throw new Error("GOOGLE_DRIVE_NOT_CONFIGURED");
  if (!Number.isInteger(input.outputIndex) || input.outputIndex < 0 || input.outputIndex > 20) {
    throw new Error("INVALID_OUTPUT_INDEX");
  }

  const service = createSupabaseServiceClient();
  const { data: generation, error } = await service
    .from("generations")
    .select("id,type,created_at")
    .eq("id", input.generationId)
    .maybeSingle();
  if (error || !generation) throw new Error("GENERATION_NOT_FOUND");
  if (generation.type !== input.kind) throw new Error("GENERATION_KIND_MISMATCH");

  const upstream = await fetchProviderMedia(input.sourceUrl);
  if (!upstream.ok || !upstream.body) {
    throw new Error(`generation_archive_provider_fetch_failed:${upstream.status}`);
  }

  const mimeType =
    upstream.headers.get("content-type")?.split(";", 1)[0]?.trim() ||
    (input.kind === "video" ? "video/mp4" : "image/png");
  const extension = safeExtension(mimeType, input.sourceUrl, input.kind);
  const filename = `generation-${input.generationId}-${input.outputIndex + 1}.${extension}`;

  const drive = getDriveStorageProvider();
  const folderId = await drive.ensureFolderPath(folderSegments(input.kind, generation.created_at));
  const existingId = await findExistingDriveFile(folderId, filename);
  if (existingId) {
    const meta = await drive.finalizeUpload(existingId);
    return {
      url: input.sourceUrl,
      providerUrl: input.sourceUrl,
      kind: input.kind,
      mimeType: meta.mimeType || mimeType,
      storageProvider: "google_drive",
      driveFileId: existingId,
      driveWebUrl: meta.webViewUrl,
      filename: meta.filename || filename,
      sizeBytes: meta.sizeBytes,
      archivedAt: new Date().toISOString(),
    };
  }

  const dataRoot = (process.env.AI_FACTORY_DATA_ROOT ?? "/srv/ai-factory").trim() || "/srv/ai-factory";
  const stagingDir = join(dataRoot, STAGING_DIR);
  await mkdir(stagingDir, { recursive: true });
  const tempPath = join(stagingDir, `${input.generationId}-${input.outputIndex}-${crypto.randomUUID()}.part`);

  try {
    await pipeline(upstream.body, createWriteStream(tempPath, { flags: "wx" }));
    const fileStat = await stat(tempPath);
    const session = await drive.createResumableUpload({
      filename,
      mimeType,
      sizeBytes: fileStat.size,
      folderId,
    });
    const driveFileId = await completeUploadFromFile({
      uploadUrl: session.uploadUrl,
      filePath: tempPath,
      mimeType,
      sizeBytes: fileStat.size,
    });
    const meta = await drive.finalizeUpload(driveFileId);

    return {
      url: input.sourceUrl,
      providerUrl: input.sourceUrl,
      kind: input.kind,
      mimeType: meta.mimeType || mimeType,
      storageProvider: "google_drive",
      driveFileId,
      driveWebUrl: meta.webViewUrl,
      filename: meta.filename || filename,
      sizeBytes: meta.sizeBytes ?? fileStat.size,
      archivedAt: new Date().toISOString(),
    };
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}
