import { z } from "zod";
import type { AssetIngestRequest } from "./types";

const uuidStrict = z.string().uuid();

export const assetIngestRequestSchema = z.object({
  source_url: z.string().min(1).max(4096),
  allowed_hosts: z.array(z.string().min(1).max(253)).min(1).max(32),
  kind: z.enum(["image", "video"]),
  project_id: uuidStrict,
  job_id: uuidStrict,
  stage: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9._-]+$/, "stage must be a safe path segment"),
  provider_task_id: uuidStrict,
  variant_index: z.number().int().min(0).max(2),
});

export function parseAssetIngestRequest(body: unknown): AssetIngestRequest {
  return assetIngestRequestSchema.parse(body);
}
