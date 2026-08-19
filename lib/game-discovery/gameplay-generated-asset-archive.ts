import "server-only";
import {
  createDriveApiClient,
  createDriveAuthClient,
  getDriveStorageProvider,
} from "@/lib/storage/drive-provider";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 150 * 1024 * 1024;

export interface ArchivedGameplayGeneratedAsset {
  driveFileId: string;
  driveWebUrl: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  archivedAt: string;
}

function safeSegment(value: string): string {
  const normalized = value.trim().replace(/[/\\\0]+/g, "-").slice(0, 180);
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("GAMEPLAY_GENERATED_ARCHIVE_SEGMENT_INVALID");
  }
  return normalized;
}

function assertPublicHttpsUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("GAMEPLAY_GENERATED_ASSET_URL_HTTPS_REQUIRED");
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /^169\.254\./.test(hostname)
  ) {
    throw new Error("GAMEPLAY_GENERATED_ASSET_URL_PRIVATE_HOST_FORBIDDEN");
  }
  return url;
}

function extensionForMime(mimeType: string, assetType: "image" | "video"): string {
  const normalized = mimeType.toLowerCase().split(";", 1)[0]?.trim();
  if (normalized === "image/png") return ".png";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return ".jpg";
  if (normalized === "video/mp4") return ".mp4";
  if (normalized === "video/webm") return ".webm";
  return assetType === "image" ? ".img" : ".video";
}

async function findExisting(folderId: string, filename: string): Promise<string | null> {
  const auth = createDriveAuthClient();
  if (!auth) throw new Error("GOOGLE_DRIVE_NOT_CONFIGURED");
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

export async function archiveGeneratedGameplayAsset(input: {
  rootCreativeRunId: string;
  generationId: string;
  shotId: string;
  assetType: "image" | "video";
  assetUrl: string;
}): Promise<ArchivedGameplayGeneratedAsset> {
  const sourceUrl = assertPublicHttpsUrl(input.assetUrl);
  const response = await fetch(sourceUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    throw new Error(`GAMEPLAY_GENERATED_ASSET_DOWNLOAD_FAILED:${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  const maxBytes = input.assetType === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`GAMEPLAY_GENERATED_ASSET_TOO_LARGE:${contentLength}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("GAMEPLAY_GENERATED_ASSET_EMPTY");
  if (buffer.length > maxBytes) throw new Error(`GAMEPLAY_GENERATED_ASSET_TOO_LARGE:${buffer.length}`);

  const mimeType =
    response.headers.get("content-type")?.split(";", 1)[0]?.trim() ||
    (input.assetType === "image" ? "image/png" : "video/mp4");
  if (input.assetType === "image" && !mimeType.startsWith("image/")) {
    throw new Error(`GAMEPLAY_GENERATED_ASSET_MIME_INVALID:${mimeType}`);
  }
  if (input.assetType === "video" && !mimeType.startsWith("video/")) {
    throw new Error(`GAMEPLAY_GENERATED_ASSET_MIME_INVALID:${mimeType}`);
  }

  const drive = getDriveStorageProvider();
  const folderId = await drive.ensureFolderPath([
    "Generated",
    "Game Discovery",
    "Stage 4",
    safeSegment(input.rootCreativeRunId),
    input.assetType === "image" ? "Reference Images" : "Gameplay Videos",
  ]);
  const filename = `${safeSegment(input.shotId)}-${safeSegment(input.generationId)}${extensionForMime(mimeType, input.assetType)}`;
  const existing = await findExisting(folderId, filename);
  if (existing) {
    const metadata = await drive.finalizeUpload(existing);
    return {
      driveFileId: existing,
      driveWebUrl: metadata.webViewUrl,
      filename: metadata.filename || filename,
      mimeType: metadata.mimeType || mimeType,
      sizeBytes: metadata.sizeBytes ?? buffer.length,
      archivedAt: new Date().toISOString(),
    };
  }

  const session = await drive.createResumableUpload({
    filename,
    mimeType,
    sizeBytes: buffer.length,
    folderId,
  });
  const driveFileId = await drive.completeResumableUpload({
    uploadUrl: session.uploadUrl,
    mimeType,
    buffer,
  });
  const metadata = await drive.finalizeUpload(driveFileId);
  return {
    driveFileId,
    driveWebUrl: metadata.webViewUrl,
    filename: metadata.filename || filename,
    mimeType: metadata.mimeType || mimeType,
    sizeBytes: metadata.sizeBytes ?? buffer.length,
    archivedAt: new Date().toISOString(),
  };
}
