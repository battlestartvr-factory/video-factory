import { z } from "zod";

export const jobTypeSchema = z.enum([
  "script",
  "post",
  "image",
  "short_video",
  "dev_diary",
]);
export const jobModeSchema = z.enum(["economy", "balanced", "quality"]);
export const jobStatusSchema = z.enum([
  "draft",
  "queued",
  "processing",
  "review",
  "completed",
  "failed",
  "cancelled",
]);

export const createJobSchema = z.object({
  projectId: z.string().uuid(),
  type: jobTypeSchema,
  mode: jobModeSchema,
  language: z.string().min(2).max(10),
  targetPlatform: z.string().min(1).max(50),
  brief: z.string().max(5000).optional().nullable(),
  sourceInput: z.string().min(1).max(2000),
});

export const reviewJobSchema = z.object({
  decision: z.enum(["approved", "revision_requested"]),
  comment: z.string().max(2000).optional().nullable(),
});

export const n8nJobUpdateSchema = z.object({
  event: z.literal("job.updated"),
  eventId: z.string().uuid(),
  jobId: z.string().uuid(),
  status: jobStatusSchema,
  progress: z.number().int().min(0).max(100).optional(),
  stage: z.string().max(200).optional().nullable(),
  message: z.string().max(1000).optional().nullable(),
  n8nExecutionId: z.string().max(100).optional().nullable(),
  assets: z
    .array(
      z.object({
        kind: z.string(),
        provider: z.string(),
        externalId: z.string().optional().nullable(),
        url: z.string().url().optional().nullable(),
        mimeType: z.string().optional().nullable(),
        sizeBytes: z.number().optional().nullable(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional()
    .default([]),
  usage: z
    .array(
      z.object({
        provider: z.string(),
        model: z.string().optional().nullable(),
        operation: z.string(),
        inputUnits: z.number().optional().nullable(),
        outputUnits: z.number().optional().nullable(),
        costUsd: z.number(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional()
    .default([]),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional()
    .nullable(),
  occurredAt: z.string().datetime(),
});

export const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  defaultLanguage: z.string().min(2).max(10).default("ru"),
  targetPlatforms: z.array(z.string()).default([]),
});

export const updateProjectSchema = createProjectSchema.partial().extend({
  status: z.enum(["active", "archived"]).optional(),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;
export type N8nJobUpdateInput = z.infer<typeof n8nJobUpdateSchema>;
