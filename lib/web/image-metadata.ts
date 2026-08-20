export interface ImageDimensions {
  width: number;
  height: number;
}

function readUInt16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUInt24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function isGif(bytes: Uint8Array): boolean {
  if (bytes.length < 10) return false;
  const signature = String.fromCharCode(...bytes.slice(0, 6));
  return signature === "GIF87a" || signature === "GIF89a";
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
    if (offset + 2 > bytes.length) return null;
    const length = readUInt16BE(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return null;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof && length >= 7) {
      const height = readUInt16BE(bytes, offset + 3);
      const width = readUInt16BE(bytes, offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30) return null;
  const riff = String.fromCharCode(...bytes.slice(0, 4));
  const webp = String.fromCharCode(...bytes.slice(8, 12));
  if (riff !== "RIFF" || webp !== "WEBP") return null;
  const kind = String.fromCharCode(...bytes.slice(12, 16));

  if (kind === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + readUInt24LE(bytes, 24),
      height: 1 + readUInt24LE(bytes, 27),
    };
  }
  if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b1 = bytes[21]!;
    const b2 = bytes[22]!;
    const b3 = bytes[23]!;
    const b4 = bytes[24]!;
    const width = 1 + (((b2 & 0x3f) << 8) | b1);
    const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    return { width, height };
  }
  if (kind === "VP8 " && bytes.length >= 30) {
    const frameStart = 20;
    if (bytes[frameStart + 3] === 0x9d && bytes[frameStart + 4] === 0x01 && bytes[frameStart + 5] === 0x2a) {
      return {
        width: readUInt16LE(bytes, frameStart + 6) & 0x3fff,
        height: readUInt16LE(bytes, frameStart + 8) & 0x3fff,
      };
    }
  }
  return null;
}

export function sniffImageMime(bytes: Uint8Array): string | null {
  if (isPng(bytes)) return "image/png";
  if (isGif(bytes)) return "image/gif";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function readImageDimensions(bytes: Uint8Array, mimeType?: string): ImageDimensions | null {
  const mime = (mimeType ?? sniffImageMime(bytes) ?? "").split(";")[0]!.trim().toLowerCase();
  if (mime === "image/png" && isPng(bytes)) {
    const width = readUInt32BE(bytes, 16);
    const height = readUInt32BE(bytes, 20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (mime === "image/gif" && isGif(bytes)) {
    const width = readUInt16LE(bytes, 6);
    const height = readUInt16LE(bytes, 8);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (mime === "image/jpeg") return jpegDimensions(bytes);
  if (mime === "image/webp") return webpDimensions(bytes);
  return null;
}
