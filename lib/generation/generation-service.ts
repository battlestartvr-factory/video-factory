import { getKieModelById } from "@/lib/models/kie";
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

const DURABLE_IMAGE_MODELS = new Set(["gpt-image-2", "nano-banana-2", "nano-banana-pro"]);
const DURABLE_VIDEO_MODELS = new Set(["kling-3", "veo-3-1", "seedance-2-5", "wan-2-7"]);

type GenerationReferenceAsset = {
  id?: string;
  url?: string;
  storagePath?: string;
  mimeType?: string;
  filename?: string;
  role?: string;
};

export interface CanonicalGenerationInput {
  requestId?: string;
  userId: string;
  projectId?: string | null;
  chatId?: string | null;
  sourceMessageId?: string | null;
  agentRunId?: string | null;
  prompt: string;
  model?: string;
  quality?: string;
  selectionSource?: string;
  presetId?: string | null;
  inputAssetIds?: string[];
  startFrameAssetId?: string;
  endFrameAssetId?: string;
  referenceAssets?: GenerationReferenceAsset[];
  settings?: Record<string, unknown>;
  mode?: string;
}

export interface CanonicalGenerationResult {
  generation: Generation;
  action: AgentAction;
}

export function toGenerationCard(generation: Generation): GenerationCardData {
  const model = getKieModelById(generation.model_id);
  const settings = generation.settings ?? {};
  return {
    generationId: generation.id,
    type: generation.type,
    mode: generation.mode,
    status: generation.status,
    prompt: generation.prompt,
    modelId: generation.model_id,
    modelName: model?.displayName,
    quality: typeof settings.quality === "string" ? settings.quality : undefined,
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

async function resolveOwnedAssets(
  userId: string,
  ids: string[],
): Promise<GenerationReferenceAsset[]> {
  if (!ids.length) return [];
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
  referenceAssets: GenerationReferenceAsset[];
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

  if (error || !data) throw new Error("Failed to create generation");

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

function rpcObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function createDurableGeneration(input: {
  requestId: string;
  type: "image" | "video";
  userId: string;
  mode: string;
  prompt: string;
  modelId: string;
  presetId?: string | null;
  settings: Record<string, unknown>;
  referenceAssets: GenerationReferenceAsset[];
  projectId?: string | null;
  chatId?: string | null;
  sourceMessageId?: string | null;
  agentRunId?: string | null;
}): Promise<CanonicalGenerationResult> {
  if (input.projectId) await assertProjectAccess(input.userId, input.projectId);
  if (input.chatId) await assertChatOwner(input.userId, input.chatId);

  const service = createSupabaseServiceClient();
  const actionInput = redactForStorage({
    prompt: input.prompt,
    model: input.modelId,
    mode: input.mode,
    settings: input.settings,
    assetIds: input.referenceAssets.map((asset) => asset.id).filter(Boolean),
  });
  const rpcName = input.type === "image"
    ? "orchestrator_create_image_generation"
    : "orchestrator_create_video_generation";

  const { data, error } = await service.rpc(rpcName, {
    payload: {
      request_id: input.requestId,
      user_id: input.userId,
      project_id: input.projectId ?? null,
      chat_id: input.chatId ?? null,
      message_id: input.sourceMessageId ?? null,
      agent_run_id: input.agentRunId ?? null,
      prompt: input.prompt,
      model_id: input.modelId,
      preset_id: input.presetId ?? null,
      mode: input.mode,
      settings: input.settings,
      reference_assets: input.referenceAssets,
      action_input: actionInput,
    },
  });

  if (error) {
    throw new Error(`Failed to create durable ${input.type} generation: ${error.message}`);
  }
  const row = rpcObject(data);
  const generation = rpcObject(row.generation);
  const action = rpcObject(row.action);
  if (typeof generation.id !== "string" || typeof action.id !== "string") {
    throw new Error(`Invalid ${rpcName} response`);
  }

  return {
    generation: generation as unknown as Generation,
    action: action as unknown as AgentAction,
  };
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
    quality:
      typeof settingsIn.quality === "string"
        ? (settingsIn.quality as import("@/lib/models/kie/types").MediaQuality)
        : input.quality
          ? (input.quality as import("@/lib/models/kie/types").MediaQuality)
          : undefined,
    outputs:
      typeof settingsIn.numOutputs === "number"
        ? settingsIn.numOutputs
        : typeof settingsIn.outputs === "number"
          ? settingsIn.outputs
          : undefined,
    mode: input.mode,
    selectionSource: (input.selectionSource as import("@/lib/models/kie/types").SelectionSource) ?? "agent",
  });
  const assets = input.inputAssetIds?.length
    ? await resolveOwnedAssets(input.userId, input.inputAssetIds)
    : (input.referenceAssets ?? []);
  const settings = {
    ...settingsIn,
    ...validated.settings,
    model_id: validated.model.id,
    requested_quality: validated.settings.quality,
    effective_quality: validated.settings.effectiveQuality,
    selection_source: validated.settings.selectionSource ?? "default",
  };

  if (DURABLE_IMAGE_MODELS.has(validated.model.id)) {
    return createDurableGeneration({
      requestId: input.requestId ?? crypto.randomUUID(),
      type: "image",
      userId: input.userId,
      mode: validated.mode,
      prompt: input.prompt,
      modelId: validated.model.id,
      presetId: input.presetId,
      settings,
      referenceAssets: assets,
      projectId: input.projectId,
      chatId: input.chatId,
      sourceMessageId: input.sourceMessageId,
      agentRunId: input.agentRunId,
    });
  }

  return createQueuedGeneration({
    userId: input.userId,
    type: "image",
    mode: validated.mode,
    prompt: input.prompt,
    modelId: validated.model.id,
    presetId: input.presetId,
    settings,
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
    quality:
      typeof settingsIn.quality === "string"
        ? (settingsIn.quality as import("@/lib/models/kie/types").MediaQuality)
        : input.quality
          ? (input.quality as import("@/lib/models/kie/types").MediaQuality)
          : undefined,
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
    selectionSource: (input.selectionSource as import("@/lib/models/kie/types").SelectionSource) ?? "agent",
  });

  const assetIds = [
    ...(input.inputAssetIds ?? []),
    ...(startFrameAssetId ? [startFrameAssetId] : []),
    ...(endFrameAssetId ? [endFrameAssetId] : []),
  ];
  const assets = assetIds.length
    ? await resolveOwnedAssets(input.userId, assetIds)
    : (input.referenceAssets ?? []);
  const withRoles: GenerationReferenceAsset[] = assets.map((asset) => ({
    ...asset,
    role:
      asset.id === startFrameAssetId
        ? "start_frame"
        : asset.id === endFrameAssetId
          ? "end_frame"
          : asset.role ?? "reference",
  }));
  const settings = {
    ...settingsIn,
    ...validated.settings,
    start_frame_asset_id: startFrameAssetId,
    end_frame_asset_id: endFrameAssetId,
    model_id: validated.model.id,
    requested_quality: validated.settings.quality,
    effective_quality: validated.settings.effectiveQuality,
    selection_source: validated.settings.selectionSource ?? "default",
  };

  if (DURABLE_VIDEO_MODELS.has(validated.model.id)) {
    return createDurableGeneration({
      requestId: input.requestId ?? crypto.randomUUID(),
      type: "video",
      userId: input.userId,
      mode: validated.mode,
      prompt: input.prompt,
      modelId: validated.model.id,
      presetId: input.presetId,
      settings,
      referenceAssets: withRoles,
      projectId: input.projectId,
      chatId: input.chatId,
      sourceMessageId: input.sourceMessageId,
      agentRunId: input.agentRunId,
    });
  }

  return createQueuedGeneration({
    userId: input.userId,
    type: "video",
    mode: validated.mode,
    prompt: input.prompt,
    modelId: validated.model.id,
    presetId: input.presetId,
    settings,
    referenceAssets: withRoles,
    projectId: input.projectId,
    chatId: input.chatId,
    sourceMessageId: input.sourceMessageId,
    actionType: "generate_video",
    agentRunId: input.agentRunId,
  });
}

export { GenerationValidationError };
