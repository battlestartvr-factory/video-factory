import type { AgentTool } from "@/lib/agent/types";
import { generateVideoSchema } from "@/lib/agent/schemas";
import { AGENT_ERROR_CODES } from "@/lib/agent/config";
import { createVideoGeneration, toGenerationCard, GenerationValidationError } from "@/lib/generation";

export const generateVideoTool: AgentTool<typeof generateVideoSchema._output> = {
  name: "generate_video",
  description:
    "Create a video using the canonical video generation service (same backend as /video). Use for image-to-video, start/end frames, camera-move variants. Do not call this only because you invented a concept — the user must ask to make a video/clip/ролик.",
  inputSchema: generateVideoSchema,
  risk: "safe",
  async handler(input, ctx) {
    try {
      const result = await createVideoGeneration({
        userId: ctx.userId,
        projectId: ctx.projectId,
        chatId: ctx.chatId,
        sourceMessageId: ctx.userMessageId,
        agentRunId: ctx.agentRunId,
        prompt: input.prompt,
        model: input.model,
        presetId: input.preset_id,
        inputAssetIds: input.input_asset_ids,
        startFrameAssetId: input.start_frame_asset_id,
        endFrameAssetId: input.end_frame_asset_id,
        mode: input.mode,
        settings: {
          aspectRatio: input.aspect_ratio,
          resolution: input.resolution,
          duration_sec: input.duration_sec,
          numOutputs: input.outputs,
        },
      });
      return {
        ok: true,
        data: {
          generation_id: result.generation.id,
          action_id: result.action.id,
          status: result.generation.status,
          action_status: result.action.status,
          model: result.generation.model_id,
          mode: result.generation.mode,
        },
        generation: toGenerationCard(result.generation),
      };
    } catch (error) {
      if (error instanceof GenerationValidationError) {
        return { ok: false, code: error.code, error: error.message };
      }
      return {
        ok: false,
        code: AGENT_ERROR_CODES.INTERNAL_ERROR,
        error: "Не удалось создать генерацию видео",
      };
    }
  },
};
