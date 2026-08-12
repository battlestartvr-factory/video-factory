import { z } from "zod";

const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertSafeMetadataKeys(value: unknown, ctx: z.RefinementCtx, path: (string | number)[]) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
      ctx.addIssue({
        code: "custom",
        message: `Forbidden metadata key: ${key}`,
        path,
      });
    }
    assertSafeMetadataKeys(
      (value as Record<string, unknown>)[key],
      ctx,
      [...path, key],
    );
  }
}

const FORBIDDEN_METADATA_KEY_PATTERN = /"(?:__proto__|constructor|prototype)"\s*:/;

const safeMetadataSchema = z
  .record(z.string(), z.unknown())
  .superRefine((obj, ctx) => {
    assertSafeMetadataKeys(obj, ctx, ["metadata"]);
    if (FORBIDDEN_METADATA_KEY_PATTERN.test(JSON.stringify(obj))) {
      ctx.addIssue({
        code: "custom",
        message: "Forbidden metadata key",
        path: ["metadata"],
      });
    }
  })
  .optional()
  .default({});

export const factoryJobTypeSchema = z.enum([
  "script",
  "post",
  "image",
  "short_video",
  "dev_diary",
]);

export const factoryPresetSchema = z.enum(["economy", "balanced", "quality"]);

export const contentNamespaceSchema = z.enum(["dev_reality", "ai_game_lab"]);

export const factoryApprovalDecisionSchema = z.enum([
  "approve",
  "regenerate",
  "cancel",
]);

export const aspectRatioSchema = z.enum([
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "21:9",
]);

export const createFactoryJobSchema = z
  .object({
    requestId: z.string().uuid().optional(),
    projectId: z.string().uuid(),
    userId: z.string().uuid().optional(),
    jobType: factoryJobTypeSchema,
    preset: factoryPresetSchema,
    contentNamespace: contentNamespaceSchema,
    prompt: z.string().trim().min(1).max(20_000),
    variants: z.number().int().min(1).max(3).optional().default(1),
    durationSeconds: z.number().int().min(1).max(60).optional(),
    aspectRatio: aspectRatioSchema.optional(),
    sourceAssetIds: z.array(z.string().uuid()).max(20).optional().default([]),
    metadata: safeMetadataSchema,
  })
  .strict();

export const factoryJobActionSchema = z
  .object({
    requestId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    decision: factoryApprovalDecisionSchema,
    stage: z.string().trim().min(1).max(200),
    comment: z.string().trim().max(2000).optional().nullable(),
    selectedAssetId: z.string().uuid().optional().nullable(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.decision === "approve" && !data.selectedAssetId) {
      ctx.addIssue({
        code: "custom",
        message: "selectedAssetId is required for approve",
        path: ["selectedAssetId"],
      });
    }
  });

export type CreateFactoryJobInput = z.infer<typeof createFactoryJobSchema>;
export type FactoryJobActionInput = z.infer<typeof factoryJobActionSchema>;
