import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";
import { DEFAULT_B2_BUCKET } from "./constants";
import { IngestError } from "./types";

export interface B2Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export interface MultipartUploadHandle {
  done: () => Promise<void>;
  abort: () => Promise<void>;
}

export type CreateMultipartUploadFn = (params: {
  config: B2Config;
  objectKey: string;
  mimeType: string;
  body: Readable;
}) => MultipartUploadHandle;

export function readB2ConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): B2Config | null {
  const endpoint = env.B2_S3_ENDPOINT?.trim();
  const region = env.B2_REGION?.trim();
  const accessKeyId = env.B2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.B2_SECRET_ACCESS_KEY?.trim();
  const bucket = (env.B2_BUCKET?.trim() || DEFAULT_B2_BUCKET).trim();

  if (!endpoint || !region || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return { endpoint, region, accessKeyId, secretAccessKey, bucket };
}

export function createS3Client(config: B2Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
  });
}

/**
 * Streaming multipart upload to B2 via S3-compatible API.
 * leavePartsOnError=false; caller must abort on failure.
 */
export function createB2MultipartUpload(params: {
  config: B2Config;
  objectKey: string;
  mimeType: string;
  body: Readable;
  client?: S3Client;
}): MultipartUploadHandle {
  const client = params.client ?? createS3Client(params.config);

  const upload = new Upload({
    client,
    leavePartsOnError: false,
    params: {
      Bucket: params.config.bucket,
      Key: params.objectKey,
      Body: params.body,
      ContentType: params.mimeType,
    },
  });

  let aborted = false;
  const originalDone = upload.done.bind(upload);

  return {
    done: async () => {
      try {
        await originalDone();
      } catch (err) {
        if (!aborted) {
          try {
            await upload.abort();
          } catch {
            // ignore secondary abort errors
          }
        }
        throw err;
      }
    },
    abort: async () => {
      aborted = true;
      try {
        await upload.abort();
      } catch {
        // best-effort cleanup; leavePartsOnError=false also helps
      }
    },
  };
}

export async function uploadStreamToB2(params: {
  config: B2Config;
  objectKey: string;
  mimeType: string;
  body: Readable;
  createUpload?: CreateMultipartUploadFn;
}): Promise<void> {
  const create = params.createUpload ?? createB2MultipartUpload;
  const handle = create({
    config: params.config,
    objectKey: params.objectKey,
    mimeType: params.mimeType,
    body: params.body,
  });

  try {
    await handle.done();
  } catch (err) {
    try {
      await handle.abort();
    } catch {
      // ignore
    }
    if (err instanceof IngestError) throw err;
    throw new IngestError("B2_UPLOAD_FAILED", 502);
  }
}
