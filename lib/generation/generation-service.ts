import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createAgentAction } from "@/lib/actions/action-service";
import { assertProjectAccess } from "@/lib/projects/access";
import { redactForStorage } from "@/lib/agent/redaction";
import type { AgentAction, ChatAttachment, Generation, GenerationCardData } from "@/lib/types/workspace";
import {
  GenerationValidationError,
  validateImageGenerationRequest,
  validateVideoGenerationRequest,
} from "./validate";

export interface CanonicalGenerationInput {
  userId: string;
  projectId?: string | null;
  chatId?: string | null;
  sourceMessageId?: string | null;
  agentRunId?: string | null;
  prompt: string;
  model?: string;
  presetId?: string | null;
  inputAssetIds?: string[];
  startFrameAssetId?: string;
  endFrameAssetId?: string;
  referenceAssets?: Array<{
    id?: string;
    url?: string;
    mimeType?: string;
    filename?: string;
    role?: string;
  }>;
  settings?: Record<string, unknown>;
  mode?: string;
}

export interface CanonicalGenerationResult {
  generation: Generation;
  action: AgentAction;
}

export function toGenerationCard(generation: Generation): GenerationCardData {
  return {
    generationId: generation.id,
    type: generation.type,
    mode: generation.mode,
    status: generation.status,
    prompt: generation.prompt,
    modelId: generation.model_id,
    outputs: generation.outputs,
  };
}

async function assertChatOwner(userId: string, chatId: string) {
  const service = createSupabaseServiceClient();
  const { data } = await service
    .from("chats")
    .select("id, user_id, project_id")
    .eq("id", chatId)
    .maybeSingle();
  if (!data || data.user_id !== userId) {
    throw new GenerationValidationError("FORBIDDEN", "Нет доступа к чату");
  }
  return data as { id: string; user_id: string; project_id: string | null };
}

async function resolveOwnedAssets(userId: string, ids: string[]) {
  if (!ids.length) return [] as Array<{ id: string; url?: string; mimeType?: string; filename?: string; role?: string }>;
  const unique = [...new Set(ids)];
  const service = createSupabaseServiceClient();
  const { data } = await service
    .from("chat_attachments")
    .select("id, filename, mime_type, url, user_id")
    .in("id", unique)
    .eq("user_id", userId);
  const rows = (data ?? []) as ChatAttachment[];
  if (rows.length !== unique.length) {
    throw new GenerationValidationError("FORBIDDEN", "Некоторые файлы недоступны");
  }
  return rows.map((row) => ({
    id: row.id,
    url: row.url ?? undefined,
    mimeType: row.mime_type,
    filename: row.filename,
  }));
}

async function createQueuedGeneration(input: {
  userId: string;
  type: "image" | "video";
  mode: string;
  prompt: string;
  modelId: string;
  presetId?: string | null;
  settings: Record<string, unknown>;
  referenceAssets: Array<{ id?: string; url?: string; mimeType?: string; filename?: string; role?: string }>;
  projectId?: string | null;
  chatId?: string | null;
  sourceMessageId?: string | null;
  actionType: string;
  agentRunId?: string | null;
}): Promise<CanonicalGenerationResult> {
  if (input.projectId) await assertProjectAccess(input.userId, input.projectId);
  if (input.chatId) await assertChatOwner(input.userId, input.chatId);

  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("generations")
    .insert({
      user_id: input.userId,
      type: input.type,
      mode: input.mode,
      prompt: input.prompt,
      model_id: input.modelId,
      preset_id: input.presetId ?? null,
      settings: input.settings,
      reference_assets: input.referenceAssets,
      project_id: input.projectId ?? null,
      chat_id: input.chatId ?? null,
      message_id: input.sourceMessageId ?? null,
      status: "queued",
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error("Failed to create generation");
  }

  const generation = data as Generation;
  const action = await createAgentAction({
    userId: input.userId,
    actionType: input.actionType,
    agentRunId: input.agentRunId,
    chatId: input.chatId,
    projectId: input.projectId,
    generationId: generation.id,
    sourceMessageId: input.sourceMessageId,
    status: "pending_dispatch",
    input: redactForStorage({
      prompt: input.prompt,
      model: input.modelId,
      mode: input.mode,
      settings: input.settings,
      assetIds: input.referenceAssets.map((asset) => asset.id).filter(Boolean),
    }),
  });

  return { generation, action };
}

export async function createImageGeneration(
  input: CanonicalGenerationInput,
): Promise<CanonicalGenerationResult> {
  const settingsIn = input.settings ?? {};
  const validated = validateImageGenerationRequest({
    modelId: input.model,
    inputAssetIds: input.inputAssetIds,
    aspectRatio: typeof settingsIn.aspectRatio === "string" ? settingsIn.aspectRatio : undefined,
    resolution: typeof settingsIn.resolution === "string" ? settingsIn.resolution : undefined,
    outputs:
      typeof settingsIn.numOutputs === "number"
        ? settingsIn.numOutputs
        : typeof settingsIn.outputs === "number"
          ? settingsIn.outputs
          : undefined,
    mode: input.mode,
  });
  const assets = input.inputAssetIds?.length
    ? await resolveOwnedAssets(input.userId, input.inputAssetIds)
    : (input.referenceAssets ?? []);

  return createQueuedGeneration({
    userId: input.userId,
    type: "image",
    mode: validated.mode,
    prompt: input.prompt,
    modelId: validated.model.id,
    presetId: input.presetId,
    settings: { ...settingsIn, ...validated.settings },
    referenceAssets: assets,
    projectId: input.projectId,
    chatId: input.chatId,
    sourceMessageId: input.sourceMessageId,
    actionType: "generate_image",
    agentRunId: input.agentRunId,
  });
}

export async function createVideoGeneration(
  input: CanonicalGenerationInput,
): Promise<CanonicalGenerationResult> {
  const settingsIn = input.settings ?? {};
  const startFrameAssetId = input.startFrameAssetId;
  const endFrameAssetId = input.endFrameAssetId;
  const validated = validateVideoGenerationRequest({
    modelId: input.model,
    inputAssetIds: input.inputAssetIds,
    startFrameAssetId,
    endFrameAssetId,
    aspectRatio: typeof settingsIn.aspectRatio === "string" ? settingsIn.aspectRatio : undefined,
    resolution: typeof settingsIn.resolution === "string" ? settingsIn.resolution : undefined,
    durationSec:
      typeof settingsIn.duration_sec === "number"
        ? settingsIn.duration_sec
        : typeof settingsIn.durationSec === "number"
          ? settingsIn.durationSec
          : typeof settingsIn.duration === "number"
            ? settingsIn.duration
            : undefined,
    outputs:
      typeof settingsIn.numOutputs === "number"
        ? settingsIn.numOutputs
        : typeof settingsIn.outputs === "number"
          ? settingsIn.outputs
          : undefined,
    mode: input.mode,
  });

  const assetIds = [
    ...(input.inputAssetIds ?? []),
    ...(startFrameAssetId ? [startFrameAssetId] : []),
    ...(endFrameAssetId ? [endFrameAssetId] : []),
  ];
  const assets = assetIds.length
    ? await resolveOwnedAssets(input.userId, assetIds)
    : (input.referenceAssets ?? []);
  const withRoles = assets.map((asset) => ({
    ...asset,
    role:
      asset.id === startFrameAssetId
        ? "start_frame"
        : asset.id === endFrameAssetId
          ? "end_frame"
          : "reference",
  }));

  return createQueuedGeneration({
    userId: input.userId,
    type: "video",
    mode: validated.mode,
    prompt: input.prompt,
    modelId: validated.model.id,
    presetId: input.presetId,
    settings: {
      ...settingsIn,
      ...validated.settings,
      start_frame_asset_id: startFrameAssetId,
      end_frame_asset_id: endFrameAssetId,
    },
    referenceAssets: withRoles,
    projectId: input.projectId,
    chatId: input.chatId,
    sourceMessageId: input.sourceMessageId,
    actionType: "generate_video",
    agentRunId: input.agentRunId,
  });
}

export { GenerationValidationError };
