import { createHash, type Hash } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

export interface HashLimitStreamOptions {
  maxBytes: number;
  onLimitExceeded: () => void;
}

/**
 * Counts bytes, computes SHA-256, and aborts when the hard size limit is exceeded.
 * Does not buffer the full payload.
 */
export class HashLimitTransform extends Transform {
  private bytes = 0;
  private readonly hash: Hash;
  private readonly maxBytes: number;
  private readonly onLimitExceeded: () => void;
  private limited = false;

  constructor(options: HashLimitStreamOptions) {
    super();
    this.maxBytes = options.maxBytes;
    this.onLimitExceeded = options.onLimitExceeded;
    this.hash = createHash("sha256");
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    if (this.limited) {
      callback();
      return;
    }

    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      this.limited = true;
      this.onLimitExceeded();
      callback(new Error("ASSET_TOO_LARGE"));
      return;
    }

    this.hash.update(chunk);
    callback(null, chunk);
  }

  get sizeBytes(): number {
    return this.bytes;
  }

  getChecksumHex(): string {
    return this.hash.digest("hex");
  }

  get wasLimited(): boolean {
    return this.limited;
  }
}
