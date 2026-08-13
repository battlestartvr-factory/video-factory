import { fileTypeFromBuffer } from "file-type";
import {
  isMimeAllowedForKind,
  MIME_TO_EXTENSION,
  MIME_SNIFF_BYTES,
} from "./constants";
import type { AssetKind } from "./types";
import { IngestError } from "./types";

export interface VerifiedMime {
  mimeType: string;
  extension: string;
}

/**
 * Detect MIME from magic bytes. Do not trust URL extension or Content-Type alone.
 */
export async function detectMimeFromMagicBytes(
  header: Uint8Array,
  kind: AssetKind,
): Promise<VerifiedMime> {
  const sample =
    header.byteLength > MIME_SNIFF_BYTES
      ? header.subarray(0, MIME_SNIFF_BYTES)
      : header;

  const detected = await fileTypeFromBuffer(sample);
  if (!detected?.mime) {
    throw new IngestError("INVALID_MIME", 400);
  }

  const mimeType = detected.mime;
  if (!isMimeAllowedForKind(mimeType, kind)) {
    throw new IngestError("INVALID_MIME", 400);
  }

  const extension = MIME_TO_EXTENSION[mimeType];
  if (!extension) {
    throw new IngestError("INVALID_MIME", 400);
  }

  return { mimeType, extension };
}

export function buildObjectKey(params: {
  projectId: string;
  jobId: string;
  stage: string;
  providerTaskId: string;
  variantIndex: number;
  extension: string;
}): string {
  return `temp/${params.projectId}/${params.jobId}/${params.stage}/${params.providerTaskId}-${params.variantIndex}.${params.extension}`;
}
