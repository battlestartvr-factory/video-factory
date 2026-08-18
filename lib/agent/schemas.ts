import { z } from "zod";

export const answerUserSchema = z.object({
  content: z.string().min(1).max(20000),
});

export const generateImageSchema = z.object({
  prompt: z.string().min(1).max(10000),
  model: z.string().min(1).max(120).optional(),
  quality: z.enum(["low", "medium", "high"]).optional(),
  preset_id: z.string().uuid().optional(),
  input_asset_ids: z.array(z.string().uuid()).max(8).optional(),
  aspect_ratio: z.string().max(20).optional(),
  resolution: z.string().max(20).optional(),
  outputs: z.number().int().min(1).max(4).optional(),
  mode: z.string().max(60).optional(),
});

export const generateVideoSchema = z.object({
  prompt: z.string().min(1).max(10000),
  model: z.string().min(1).max(120).optional(),
  quality: z.enum(["low", "medium", "high"]).optional(),
  preset_id: z.string().uuid().optional(),
  input_asset_ids: z.array(z.string().uuid()).max(8).optional(),
  start_frame_asset_id: z.string().uuid().optional(),
  end_frame_asset_id: z.string().uuid().optional(),
  duration_sec: z.number().int().min(1).max(60).optional(),
  aspect_ratio: z.string().max(20).optional(),
  resolution: z.string().max(40).optional(),
  outputs: z.number().int().min(1).max(4).optional(),
  mode: z.string().max(60).optional(),
});

export const searchKnowledgeSchema = z.object({
  query: z.string().min(1).max(2000),
  scope: z.enum(["global", "project", "all"]).optional(),
});

export const addToKnowledgeSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  content: z.string().min(1).max(50000).optional(),
  attachment_id: z.string().uuid().optional(),
  scope: z.enum(["global", "project"]).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

export const listKnowledgeDocumentsSchema = z.object({
  scope: z.enum(["global", "project", "all"]).optional(),
});

export const searchMemorySchema = z.object({
  query: z.string().min(1).max(2000),
  scope: z.enum(["global", "project", "all"]).optional(),
});

export const saveMemorySchema = z.object({
  content: z.string().min(1).max(5000),
  scope: z.enum(["global", "project"]).optional(),
  category: z.string().max(100).optional(),
  importance: z.number().int().min(1).max(10).optional(),
  source: z.string().max(500).optional(),
  learned_from: z.string().max(120).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(z.string().min(1).max(1000)).max(12).optional(),
});

export const updateMemorySchema = z.object({
  memory_id: z.string().uuid(),
  content: z.string().min(1).max(5000).optional(),
  category: z.string().max(100).optional().nullable(),
  importance: z.number().int().min(1).max(10).optional(),
  pinned: z.boolean().optional(),
  enabled: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional().nullable(),
  evidence: z.array(z.string().min(1).max(1000)).max(12).optional(),
});

export const getProjectContextSchema = z.object({
  project_id: z.string().uuid().optional(),
});

export const listProjectFilesSchema = z.object({
  project_id: z.string().uuid().optional(),
});

export const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  default_language: z.string().min(2).max(10).optional(),
  target_platforms: z.array(z.string().max(50)).max(20).optional(),
});

export const updateProjectInstructionsSchema = z.object({
  instructions: z.string().max(10000),
  project_id: z.string().uuid().optional(),
  confirmed: z.boolean().optional(),
});

export const inspectAttachmentSchema = z.object({
  attachment_id: z.string().uuid(),
});

export const extractDocumentSchema = z.object({
  attachment_id: z.string().uuid().optional(),
  document_id: z.string().uuid().optional(),
});

export const webSearchSchema = z.object({
  query: z.string().min(1).max(500),
  max_results: z.number().int().min(1).max(8).optional(),
});

export const webFetchSchema = z.object({
  url: z.string().url().max(2000),
});

export const startGameDiscoverySchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  search_intent: z.string().trim().min(1).max(4000).optional(),
  desired_novelty: z.enum(["explore", "balanced", "exploit"]).optional(),
  concept_count: z.number().int().min(2).max(12).optional(),
  max_concepts_to_prototype: z.number().int().min(1).max(4).optional(),
});

export function zodToFunctionParameters(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  delete json.$id;
  if (json.type !== "object") {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  return json;
}
