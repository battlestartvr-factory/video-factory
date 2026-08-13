import { Readable } from "node:stream";
import {
  INGEST_OPERATION_TIMEOUT_MS,
  maxBytesForKind,
  MIME_SNIFF_BYTES,
} from "./constants";
import { HashLimitTransform } from "./hash-limit-stream";
import { buildObjectKey, detectMimeFromMagicBytes } from "./mime";
import {
  createB2MultipartUpload,
  readB2ConfigFromEnv,
  uploadStreamToB2,
  type B2Config,
  type CreateMultipartUploadFn,
} from "./b2-upload";
import {
  validateSourceUrlForIngest,
  type DnsLookupFn,
} from "./url-safety";
import type { AssetIngestRequest, AssetIngestSuccess } from "./types";
import { IngestError } from "./types";

export interface IngestDeps {
  fetchFn?: typeof fetch;
  dnsLookup?: DnsLookupFn;
  b2Config?: B2Config | null;
  createUpload?: CreateMultipartUploadFn;
  operationTimeoutMs?: number;
  /** Test-only override for hard size limit. */
  maxBytesOverride?: number;
}

async function readExactPrefix(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  byteCount: number,
): Promise<{ prefix: Uint8Array; remainder: Uint8Array | null; done: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let remainder: Uint8Array | null = null;
  let done = false;

  while (total < byteCount) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) {
      done = true;
      break;
    }
    if (!value || value.byteLength === 0) continue;

    if (total + value.byteLength <= byteCount) {
      chunks.push(value);
      total += value.byteLength;
    } else {
      const need = byteCount - total;
      chunks.push(value.subarray(0, need));
      remainder = value.subarray(need);
      total += need;
      break;
    }
  }

  return { prefix: concatUint8(chunks), remainder, done };
}

function concatUint8(chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(len);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function webStreamFromParts(
  prefix: Uint8Array,
  remainder: Uint8Array | null,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  upstreamDone: boolean,
): ReadableStream<Uint8Array> {
  let phase: "prefix" | "remainder" | "tail" | "end" = "prefix";

  return new ReadableStream({
    async pull(controller) {
      if (phase === "prefix") {
        phase = remainder ? "remainder" : upstreamDone ? "end" : "tail";
        if (prefix.byteLength > 0) {
          controller.enqueue(prefix);
          return;
        }
      }

      if (phase === "remainder") {
        phase = upstreamDone ? "end" : "tail";
        if (remainder && remainder.byteLength > 0) {
          controller.enqueue(remainder);
          return;
        }
      }

      if (phase === "end") {
        controller.close();
        return;
      }

      const { value, done } = await reader.read();
      if (done) {
        phase = "end";
        controller.close();
        return;
      }
      if (value) controller.enqueue(value);
    },
    cancel() {
      void reader.cancel();
    },
  });
}

export async function runAssetIngest(
  request: AssetIngestRequest,
  deps: IngestDeps = {},
): Promise<AssetIngestSuccess> {
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.operationTimeoutMs ?? INGEST_OPERATION_TIMEOUT_MS;
  const b2Config =
    deps.b2Config === undefined ? readB2ConfigFromEnv() : deps.b2Config;

  if (!b2Config) {
    throw new IngestError("NOT_CONFIGURED", 503);
  }

  await validateSourceUrlForIngest(
    request.source_url,
    request.allowed_hosts,
    deps.dnsLookup,
  );

  const maxBytes = deps.maxBytesOverride ?? maxBytesForKind(request.kind);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  let uploadAbort: (() => Promise<void>) | null = null;

  try {
    let upstream: Response;
    try {
      upstream = await fetchFn(request.source_url, {
        method: "GET",
        redirect: "manual",
        signal: abortController.signal,
        headers: { Accept: "*/*" },
      });
    } catch {
      if (abortController.signal.aborted) {
        throw new IngestError("DOWNLOAD_TIMEOUT", 504);
      }
      throw new IngestError("UPSTREAM_ERROR", 502);
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      throw new IngestError("UNSAFE_URL", 400);
    }

    if (!upstream.ok) {
      throw new IngestError("UPSTREAM_ERROR", 502);
    }

    const contentLengthHeader = upstream.headers.get("content-length");
    if (contentLengthHeader != null && contentLengthHeader !== "") {
      const contentLength = Number.parseInt(contentLengthHeader, 10);
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        throw new IngestError("UPSTREAM_ERROR", 502);
      }
      if (contentLength > maxBytes) {
        throw new IngestError("ASSET_TOO_LARGE", 413);
      }
    }

    if (!upstream.body) {
      throw new IngestError("UPSTREAM_ERROR", 502);
    }

    const reader = upstream.body.getReader();
    const { prefix, remainder, done } = await readExactPrefix(
      reader,
      MIME_SNIFF_BYTES,
    );

    if (prefix.byteLength === 0) {
      throw new IngestError("INVALID_MIME", 400);
    }

    if (prefix.byteLength > maxBytes) {
      abortController.abort();
      throw new IngestError("ASSET_TOO_LARGE", 413);
    }

    const verified = await detectMimeFromMagicBytes(prefix, request.kind);
    const objectKey = buildObjectKey({
      projectId: request.project_id,
      jobId: request.job_id,
      stage: request.stage,
      providerTaskId: request.provider_task_id,
      variantIndex: request.variant_index,
      extension: verified.extension,
    });

    const webBody = webStreamFromParts(prefix, remainder, reader, done);
    const nodeBody = Readable.fromWeb(webBody as never);

    let sizeExceeded = false;
    const hashLimit = new HashLimitTransform({
      maxBytes,
      onLimitExceeded: () => {
        sizeExceeded = true;
        abortController.abort();
        void reader.cancel().catch(() => undefined);
        if (uploadAbort) {
          void uploadAbort().catch(() => undefined);
        }
      },
    });

    const pipeline = nodeBody.pipe(hashLimit);

    const baseCreate: CreateMultipartUploadFn =
      deps.createUpload ?? createB2MultipartUpload;

    const wrappedCreate: CreateMultipartUploadFn = (args) => {
      const handle = baseCreate(args);
      uploadAbort = () => handle.abort();
      return handle;
    };

    try {
      await uploadStreamToB2({
        config: b2Config,
        objectKey,
        mimeType: verified.mimeType,
        body: pipeline,
        createUpload: wrappedCreate,
      });
    } catch (err) {
      if (
        sizeExceeded ||
        (err instanceof Error && err.message === "ASSET_TOO_LARGE")
      ) {
        throw new IngestError("ASSET_TOO_LARGE", 413);
      }
      if (abortController.signal.aborted && !sizeExceeded) {
        throw new IngestError("DOWNLOAD_TIMEOUT", 504);
      }
      if (err instanceof IngestError) throw err;
      throw new IngestError("B2_UPLOAD_FAILED", 502);
    }

    if (sizeExceeded) {
      throw new IngestError("ASSET_TOO_LARGE", 413);
    }

    let checksum: string;
    try {
      checksum = hashLimit.getChecksumHex();
    } catch {
      throw new IngestError("B2_UPLOAD_FAILED", 502);
    }

    return {
      ok: true,
      bucket: b2Config.bucket,
      object_key: objectKey,
      kind: request.kind,
      mime_type: verified.mimeType,
      size_bytes: hashLimit.sizeBytes,
      checksum_sha256: checksum,
    };
  } finally {
    clearTimeout(timeout);
  }
}
