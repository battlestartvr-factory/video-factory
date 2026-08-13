import type { AssetKind } from "./types";

/** Full operation timeout (download + upload), milliseconds. */
export const INGEST_OPERATION_TIMEOUT_MS = 240_000;

export const IMAGE_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB
export const VIDEO_MAX_BYTES = 250 * 1024 * 1024; // 250 MiB

export const ALLOWED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
] as const);

export const ALLOWED_VIDEO_MIMES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
] as const);

export const MIME_TO_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export const DEFAULT_B2_BUCKET = "battlestart-factory-temp";

/** Bytes to peek for magic-number MIME detection. */
export const MIME_SNIFF_BYTES = 4100;

export function maxBytesForKind(kind: AssetKind): number {
  return kind === "image" ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
}

export function isMimeAllowedForKind(mime: string, kind: AssetKind): boolean {
  if (kind === "image") return ALLOWED_IMAGE_MIMES.has(mime as never);
  return ALLOWED_VIDEO_MIMES.has(mime as never);
}
