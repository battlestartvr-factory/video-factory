import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runAssetIngest } from "@/lib/asset-ingest/ingest";
import { IMAGE_MAX_BYTES } from "@/lib/asset-ingest/constants";
import type { CreateMultipartUploadFn } from "@/lib/asset-ingest/b2-upload";
import {
  baseIngestBody,
  mp4Bytes,
  pngBytes,
  spoofedGifAsPng,
} from "./asset-ingest-fixtures";

const b2Config = {
  endpoint: "https://s3.example.backblazeb2.com",
  region: "us-west-004",
  accessKeyId: "key-id",
  secretAccessKey: "secret",
  bucket: "battlestart-factory-temp",
};

function publicDns() {
  return async () => [{ address: "93.184.216.34", family: 4 }];
}

function responseFromBytes(
  bytes: Uint8Array,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(Buffer.from(bytes), {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

function collectingUpload(): {
  createUpload: CreateMultipartUploadFn;
  aborts: number;
  uploaded: Buffer[];
} {
  const uploaded: Buffer[] = [];
  let aborts = 0;

  const createUpload: CreateMultipartUploadFn = ({ body }) => {
    return {
      done: async () => {
        await new Promise<void>((resolve, reject) => {
          const onData = (chunk: Buffer) => uploaded.push(Buffer.from(chunk));
          const onEnd = () => {
            cleanup();
            resolve();
          };
          const onError = (err: Error) => {
            cleanup();
            reject(err);
          };
          const cleanup = () => {
            body.off("data", onData);
            body.off("end", onEnd);
            body.off("error", onError);
          };
          body.on("data", onData);
          body.on("end", onEnd);
          body.on("error", onError);
          if (body.readableEnded) {
            cleanup();
            resolve();
          }
        });
      },
      abort: async () => {
        aborts += 1;
        if (typeof (body as Readable).destroy === "function") {
          (body as Readable).destroy(new Error("ASSET_TOO_LARGE"));
        }
      },
    };
  };

  return {
    createUpload,
    get aborts() {
      return aborts;
    },
    uploaded,
  };
}

describe("asset-ingest runAssetIngest integration", () => {
  it("ingests a valid image and returns verified metadata", async () => {
    const bytes = pngBytes(128);
    const expectedSha = createHash("sha256").update(bytes).digest("hex");
    const upload = collectingUpload();

    const result = await runAssetIngest(baseIngestBody(), {
      b2Config,
      dnsLookup: publicDns(),
      fetchFn: async () =>
        responseFromBytes(bytes, {
          headers: { "content-type": "application/octet-stream" },
        }),
      createUpload: upload.createUpload,
    });

    expect(result.ok).toBe(true);
    expect(result.mime_type).toBe("image/png");
    expect(result.size_bytes).toBe(128);
    expect(result.checksum_sha256).toBe(expectedSha);
    expect(result.checksum_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.object_key).toContain(".png");
    expect(result.bucket).toBe("battlestart-factory-temp");
    expect(Buffer.concat(upload.uploaded).byteLength).toBe(128);
  });

  it("ingests a valid video", async () => {
    const bytes = mp4Bytes(256);
    const upload = collectingUpload();

    const result = await runAssetIngest(
      baseIngestBody({
        kind: "video",
        source_url: "https://file.aiquickdraw.com/out/a.mp4",
      }),
      {
        b2Config,
        dnsLookup: publicDns(),
        fetchFn: async () => responseFromBytes(bytes),
        createUpload: upload.createUpload,
      },
    );

    expect(result.mime_type).toBe("video/mp4");
    expect(result.object_key.endsWith(".mp4")).toBe(true);
    expect(result.size_bytes).toBe(256);
  });

  it("rejects oversized Content-Length before streaming", async () => {
    const fetchFn = vi.fn(async () =>
      responseFromBytes(pngBytes(16), {
        headers: { "content-length": String(IMAGE_MAX_BYTES + 1) },
      }),
    );

    await expect(
      runAssetIngest(baseIngestBody(), {
        b2Config,
        dnsLookup: publicDns(),
        fetchFn,
        createUpload: collectingUpload().createUpload,
      }),
    ).rejects.toMatchObject({ code: "ASSET_TOO_LARGE" });
  });

  it("enforces hard limit during streaming when Content-Length is missing", async () => {
    // Limit must be > MIME sniff window so overflow happens mid-stream into B2.
    const limit = 5_000;
    const huge = pngBytes(limit + 1_000);
    const upload = collectingUpload();

    await expect(
      runAssetIngest(baseIngestBody(), {
        b2Config,
        dnsLookup: publicDns(),
        fetchFn: async () => responseFromBytes(huge),
        createUpload: upload.createUpload,
        maxBytesOverride: limit,
      }),
    ).rejects.toMatchObject({ code: "ASSET_TOO_LARGE" });

    expect(upload.aborts).toBeGreaterThanOrEqual(1);
  });

  it("rejects false Content-Length that claims under-limit while body exceeds", async () => {
    // Content-Length lies small; body is over limit — byte counter must catch it
    const limit = 5_000;
    const huge = pngBytes(limit + 1_000);
    const upload = collectingUpload();

    await expect(
      runAssetIngest(baseIngestBody(), {
        b2Config,
        dnsLookup: publicDns(),
        fetchFn: async () =>
          responseFromBytes(huge, {
            headers: { "content-length": "100" },
          }),
        createUpload: upload.createUpload,
        maxBytesOverride: limit,
      }),
    ).rejects.toMatchObject({ code: "ASSET_TOO_LARGE" });

    expect(upload.aborts).toBeGreaterThanOrEqual(1);
  });

  it("allows missing Content-Length for valid small assets", async () => {
    const bytes = pngBytes(80);
    const result = await runAssetIngest(baseIngestBody(), {
      b2Config,
      dnsLookup: publicDns(),
      fetchFn: async () => responseFromBytes(bytes),
      createUpload: collectingUpload().createUpload,
    });
    expect(result.size_bytes).toBe(80);
  });

  it("rejects redirects", async () => {
    await expect(
      runAssetIngest(baseIngestBody(), {
        b2Config,
        dnsLookup: publicDns(),
        fetchFn: async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://evil.example/x" },
          }),
        createUpload: collectingUpload().createUpload,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_URL" });
  });

  it("rejects MIME spoofing", async () => {
    await expect(
      runAssetIngest(
        baseIngestBody({ source_url: "https://file.aiquickdraw.com/a.png" }),
        {
          b2Config,
          dnsLookup: publicDns(),
          fetchFn: async () => responseFromBytes(spoofedGifAsPng()),
          createUpload: collectingUpload().createUpload,
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_MIME" });
  });

  it("maps upstream abort/timeout to DOWNLOAD_TIMEOUT", async () => {
    await expect(
      runAssetIngest(baseIngestBody(), {
        b2Config,
        dnsLookup: publicDns(),
        operationTimeoutMs: 20,
        fetchFn: async (_url, init) => {
          await new Promise<void>((_resolve, reject) => {
            const t = setTimeout(() => reject(new Error("abort")), 50);
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(t);
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          });
          return responseFromBytes(pngBytes());
        },
        createUpload: collectingUpload().createUpload,
      }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_TIMEOUT" });
  });

  it("aborts B2 multipart upload on upload failure", async () => {
    let aborted = 0;
    const createUpload: CreateMultipartUploadFn = ({ body }) => ({
      done: async () => {
        // consume a bit then fail
        await new Promise<void>((resolve) => {
          body.once("data", () => resolve());
          body.resume();
        });
        throw new Error("multipart exploded");
      },
      abort: async () => {
        aborted += 1;
      },
    });

    await expect(
      runAssetIngest(baseIngestBody(), {
        b2Config,
        dnsLookup: publicDns(),
        fetchFn: async () => responseFromBytes(pngBytes(128)),
        createUpload,
      }),
    ).rejects.toMatchObject({ code: "B2_UPLOAD_FAILED" });

    expect(aborted).toBeGreaterThanOrEqual(1);
  });

  it("rejects forbidden hostname before fetch", async () => {
    const fetchFn = vi.fn();
    await expect(
      runAssetIngest(
        baseIngestBody({
          source_url: "https://not-allowed.example/a.png",
          allowed_hosts: ["file.aiquickdraw.com"],
        }),
        {
          b2Config,
          dnsLookup: publicDns(),
          fetchFn,
          createUpload: collectingUpload().createUpload,
        },
      ),
    ).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects private IPv4 DNS before fetch", async () => {
    const fetchFn = vi.fn();
    await expect(
      runAssetIngest(baseIngestBody(), {
        b2Config,
        dnsLookup: async () => [{ address: "192.168.0.10", family: 4 }],
        fetchFn,
        createUpload: collectingUpload().createUpload,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_URL" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects private IPv6 DNS before fetch", async () => {
    const fetchFn = vi.fn();
    await expect(
      runAssetIngest(baseIngestBody(), {
        b2Config,
        dnsLookup: async () => [{ address: "fe80::1", family: 6 }],
        fetchFn,
        createUpload: collectingUpload().createUpload,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_URL" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
