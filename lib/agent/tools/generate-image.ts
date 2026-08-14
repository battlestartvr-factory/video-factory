import type { AgentTool } from "@/lib/agent/types";
import { generateImageSchema } from "@/lib/agent/schemas";
import { AGENT_ERROR_CODES } from "@/lib/agent/config";
import { createImageGeneration, toGenerationCard, GenerationValidationError } from "@/lib/generation";

export const generateImageTool: AgentTool<typeof generateImageSchema._output> = {
  name: "generate_image",
  description:
    "Create or edit an image using the canonical image generation service (same backend as /images). Use for posters, character variants, cinematic edits, reference-based images. Pass attachment UUIDs as input_asset_ids when the user provided images.",
  inputSchema: generateImageSchema,
  risk: "safe",
  async handler(input, ctx) {
    try {
      const result = await createImageGeneration({
        userId: ctx.userId,
        projectId: ctx.projectId,
        chatId: ctx.chatId,
        sourceMessageId: ctx.userMessageId,
        agentRunId: ctx.agentRunId,
        prompt: input.prompt,
        model: input.model,
        presetId: input.preset_id,
        inputAssetIds: input.input_asset_ids,
        mode: input.mode,
        settings: {
          aspectRatio: input.aspect_ratio,
          resolution: input.resolution,
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
        error: "Не удалось создать генерацию изображения",
      };
    }
  },
};
