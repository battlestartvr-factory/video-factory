/**
 * Minimal binary fixtures for magic-byte MIME detection tests.
 * Not real media files — only signature headers + padding enough for file-type.
 */

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.byteLength);
  const typeBytes = new TextEncoder().encode(type);
  const crcInput = new Uint8Array(typeBytes.byteLength + data.byteLength);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.byteLength);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(crcInput));
  const out = new Uint8Array(4 + typeBytes.byteLength + data.byteLength + 4);
  out.set(len, 0);
  out.set(typeBytes, 4);
  out.set(data, 4 + typeBytes.byteLength);
  out.set(crc, 4 + typeBytes.byteLength + data.byteLength);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

export function pngBytes(totalLength = 64): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 1);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const core = concat(
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IEND", new Uint8Array(0)),
  );
  if (totalLength <= core.byteLength) return core;
  const buf = new Uint8Array(totalLength);
  buf.set(core, 0);
  return buf;
}

export function jpegBytes(totalLength = 64): Uint8Array {
  const buf = new Uint8Array(totalLength);
  buf.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46], 0);
  return buf;
}

export function webpBytes(totalLength = 64): Uint8Array {
  const buf = new Uint8Array(Math.max(totalLength, 12));
  buf.set([0x52, 0x49, 0x46, 0x46], 0);
  const size = buf.byteLength - 8;
  buf[4] = size & 0xff;
  buf[5] = (size >> 8) & 0xff;
  buf[6] = (size >> 16) & 0xff;
  buf[7] = (size >> 24) & 0xff;
  buf.set([0x57, 0x45, 0x42, 0x50], 8);
  return buf;
}

/** ISO BMFF with ftyp/isom — detected as video/mp4 */
export function mp4Bytes(totalLength = 64): Uint8Array {
  const buf = new Uint8Array(Math.max(totalLength, 24));
  buf.set([0x00, 0x00, 0x00, 0x18], 0);
  buf.set([0x66, 0x74, 0x79, 0x70], 4);
  buf.set([0x69, 0x73, 0x6f, 0x6d], 8);
  buf.set([0x00, 0x00, 0x00, 0x01], 12);
  buf.set([0x69, 0x73, 0x6f, 0x6d], 16);
  return buf;
}

/** QuickTime ftyp/qt  — video/quicktime */
export function movBytes(totalLength = 64): Uint8Array {
  const buf = new Uint8Array(Math.max(totalLength, 20));
  buf.set([0x00, 0x00, 0x00, 0x14], 0);
  buf.set([0x66, 0x74, 0x79, 0x70], 4);
  buf.set([0x71, 0x74, 0x20, 0x20], 8);
  buf.set([0x00, 0x00, 0x00, 0x00], 12);
  return buf;
}

/** EBML DocType=webm — video/webm */
export function webmBytes(totalLength = 64): Uint8Array {
  const header = new Uint8Array([
    0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f,
    0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04,
    0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x42,
    0x87, 0x81, 0x02, 0x42, 0x85, 0x81, 0x02,
  ]);
  if (totalLength <= header.byteLength) return header;
  const buf = new Uint8Array(totalLength);
  buf.set(header, 0);
  return buf;
}

/** GIF magic — rejected for image kind (MIME spoof) */
export function spoofedGifAsPng(): Uint8Array {
  const buf = new Uint8Array(64);
  buf.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  return buf;
}

import type { AssetIngestRequest } from "@/lib/asset-ingest/types";

export const SAMPLE_UUIDS = {
  project: "11111111-1111-4111-8111-111111111111",
  job: "22222222-2222-4222-8222-222222222222",
  providerTask: "33333333-3333-4333-8333-333333333333",
};

export function baseIngestBody(
  overrides: Partial<AssetIngestRequest> = {},
): AssetIngestRequest {
  return {
    source_url: "https://file.aiquickdraw.com/out/a.png",
    allowed_hosts: ["file.aiquickdraw.com"],
    kind: "image",
    project_id: SAMPLE_UUIDS.project,
    job_id: SAMPLE_UUIDS.job,
    stage: "keyframes",
    provider_task_id: SAMPLE_UUIDS.providerTask,
    variant_index: 0,
    ...overrides,
  };
}

