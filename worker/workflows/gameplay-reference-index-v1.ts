import { indexGameplayReference } from "../../lib/game-discovery/gameplay-reference-service";
import { createSupabaseServiceClient } from "../../lib/supabase/server";
import type { WorkflowTickHandler } from "./types";

interface ReferenceIndexJobInput {
  reference_id?: unknown;
}

async function getReferenceId(jobId: string): Promise<string> {
  const supabase = createSupabaseServiceClient();
  const { data, error } = await supabase.from("factory_jobs").select("input").eq("id", jobId).single();
  if (error || !data) throw new Error(`GAMEPLAY_REFERENCE_INDEX_JOB_NOT_FOUND:${jobId}`);
  const input = (data.input ?? {}) as ReferenceIndexJobInput;
  const referenceId = typeof input.reference_id === "string" ? input.reference_id.trim() : "";
  if (!referenceId) throw new Error("GAMEPLAY_REFERENCE_INDEX_JOB_REFERENCE_ID_REQUIRED");
  return referenceId;
}

function failure(error: unknown, referenceId?: string) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: "failed" as const,
    state: {
      ...(referenceId ? { reference_id: referenceId } : {}),
      model_calls_allowed: 1,
      automatic_retry_allowed: false,
    },
    currentStage: "caption_failed",
    progress: 1,
    error: {
      code: message.split(":", 1)[0] || "GAMEPLAY_REFERENCE_INDEX_FAILED",
      message: message.slice(0, 2_000),
      retryable: false,
    },
    stateReason: "gameplay_reference_caption_failed_no_auto_retry",
    eventType: "gameplay_reference.index_failed",
    eventPayload: {
      ...(referenceId ? { reference_id: referenceId } : {}),
      error: message.slice(0, 2_000),
      automatic_retry_allowed: false,
    },
  };
}

export const gameplayReferenceIndexV1: WorkflowTickHandler = async (context) => {
  let referenceId: string | undefined;
  try {
    referenceId = await getReferenceId(context.jobId);
    const spec = await indexGameplayReference({ referenceId });
    return {
      status: "completed",
      state: {
        reference_id: referenceId,
        camera_type: spec.cameraType,
        controllable_player_obvious: spec.controllablePlayerObvious,
        coop_dependency_visible: spec.coopDependencyVisible,
        canonical_reference_id: spec.canonicalReferenceId ?? null,
        model_calls_allowed: 1,
        automatic_retry_allowed: false,
      },
      currentStage: "indexed",
      progress: 1,
      result: {
        reference_id: referenceId,
        game_name: spec.gameName,
        camera_type: spec.cameraType,
        current_player_action: spec.currentPlayerAction,
        visible_input_affordance: spec.visibleInputAffordance,
        game_response: spec.gameResponse,
        gameplay_description: spec.gameplayDescription,
        why_this_looks_like_gameplay: spec.whyThisLooksLikeGameplay,
        canonical_reference_id: spec.canonicalReferenceId ?? null,
      },
      stateReason: "gameplay_reference_indexed",
      eventType: "gameplay_reference.indexed",
      eventPayload: {
        reference_id: referenceId,
        game_name: spec.gameName,
        camera_type: spec.cameraType,
        canonical_reference_id: spec.canonicalReferenceId ?? null,
      },
    };
  } catch (error) {
    return failure(error, referenceId);
  }
};
