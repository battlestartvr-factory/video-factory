import { z } from "zod";

export const createChatSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  title: z.string().min(1).max(200).optional(),
  modelId: z.string().optional(),
  presetId: z.string().uuid().optional(),
});

export const updateChatSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  modelId: z.string().optional().nullable(),
  presetId: z.string().uuid().optional().nullable(),
  archived: z.boolean().optional(),
  summary: z.string().optional().nullable(),
});

export const sendMessageSchema = z.object({
  content: z.string().min(1).max(50000),
  modelId: z.string().optional(),
  presetId: z.string().uuid().optional(),
  attachmentIds: z.array(z.string().uuid()).optional(),
});

export const createPresetSchema = z.object({
  type: z.enum(["chat", "image", "video"]),
  name: z.string().min(1).max(100),
  settings: z.record(z.string(), z.unknown()).optional(),
  isDefault: z.boolean().optional(),
});

export const updatePresetSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  isDefault: z.boolean().optional(),
});

export const createMemorySchema = z.object({
  scope: z.enum(["global", "project"]),
  projectId: z.string().uuid().optional().nullable(),
  content: z.string().min(1).max(5000),
  category: z.string().max(100).optional(),
  source: z.string().max(200).optional(),
  importance: z.number().int().min(1).max(10).optional(),
  pinned: z.boolean().optional(),
});

export const updateMemorySchema = z.object({
  content: z.string().min(1).max(5000).optional(),
  category: z.string().max(100).optional().nullable(),
  importance: z.number().int().min(1).max(10).optional(),
  pinned: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export const updatePreferencesSchema = z.object({
  personalization: z
    .object({
      aboutMe: z.string().max(5000).optional(),
      communicationStyle: z.string().max(500).optional(),
      globalInstructions: z.string().max(5000).optional(),
      preferredLanguage: z.string().max(10).optional(),
      agentBehavior: z.string().max(2000).optional(),
    })
    .optional(),
  appearance: z
    .object({
      theme: z.enum(["dark", "light", "system"]).optional(),
      accentColor: z.enum(["amber", "violet", "emerald", "rose", "sky"]).optional(),
      font: z.enum(["geist", "system", "mono"]).optional(),
      density: z.enum(["comfortable", "compact"]).optional(),
    })
    .optional(),
});

export const createGenerationSchema = z.object({
  type: z.enum(["image", "video"]),
  mode: z.string().min(1),
  prompt: z.string().min(1).max(10000),
  modelId: z.string().min(1),
  presetId: z.string().uuid().optional().nullable(),
  settings: z.record(z.string(), z.unknown()).optional(),
  referenceAssets: z
    .array(
      z.object({
        url: z.string().optional(),
        mimeType: z.string().optional(),
        filename: z.string().optional(),
      }),
    )
    .optional(),
  projectId: z.string().uuid().optional().nullable(),
  chatId: z.string().uuid().optional().nullable(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  systemPrompt: z.string().max(10000).optional().nullable(),
});

export const knowledgeUploadSchema = z.object({
  knowledgeBaseId: z.string().uuid().optional(),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const knowledgeQuerySchema = z.object({
  query: z.string().min(1).max(2000),
  knowledgeBaseId: z.string().uuid().optional(),
});
