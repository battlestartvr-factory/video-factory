import type { WorkflowTickHandler } from "./types";

interface IndexedReferenceResult extends Record<string, unknown> {
  reference_id: string;
  game_name: string;
  camera_type: string;
  controllable_player_obvious: boolean;
  coop_dependency_visible: boolean;
  current_player_action: string;
  visible_input_affordance: string;
  game_response: string;
  gameplay_description: string;
  why_this_looks_like_gameplay: string;
  canonical_reference_id: string | null;
}

function referenceIdFromState(state: Record<string, unknown>): string {
  const value = state.reference_id;
  const referenceId = typeof value === "string" ? value.trim() : "";
  if (!referenceId) throw new Error("GAMEPLAY_REFERENCE_INDEX_JOB_REFERENCE_ID_REQUIRED");
  return referenceId;
}

function serviceToken(): string {
  const token = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? "").trim();
  if (!token) throw new Error("GAMEPLAY_REFERENCE_INDEX_SERVICE_TOKEN_MISSING");
  return token;
}

function internalBaseUrl(): string {
  return (process.env.WORKER_APP_INTERNAL_URL ?? "http://app:3000").trim() || "http://app:3000";
}

async function requestIndex(referenceId: string, signal: AbortSignal): Promise<IndexedReferenceResult> {
  const response = await fetch(`${internalBaseUrl()}/api/internal/gameplay-reference-index`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ referenceId }),
    signal,
  });
  const rawText = await response.text();
  let payload: { ok?: boolean; code?: string; message?: string; data?: IndexedReferenceResult } = {};
  try {
    payload = JSON.parse(rawText) as typeof payload;
  } catch {
    // Keep the error deterministic and do not expose an upstream HTML/body dump.
  }
  if (!response.ok || !payload.ok || !payload.data) {
    throw new Error(
      `${payload.code ?? "GAMEPLAY_REFERENCE_INDEX_UPSTREAM_FAILED"}:${payload.message ?? response.status}`,
    );
  }
  return payload.data;
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
    referenceId = referenceIdFromState(context.state);
    const indexed = await requestIndex(referenceId, context.signal);
    return {
      status: "completed",
      state: {
        reference_id: referenceId,
        camera_type: indexed.camera_type,
        controllable_player_obvious: indexed.controllable_player_obvious,
        coop_dependency_visible: indexed.coop_dependency_visible,
        canonical_reference_id: indexed.canonical_reference_id,
        model_calls_allowed: 1,
        automatic_retry_allowed: false,
      },
      currentStage: "indexed",
      progress: 1,
      result: indexed,
      stateReason: "gameplay_reference_indexed",
      eventType: "gameplay_reference.indexed",
      eventPayload: {
        reference_id: referenceId,
        game_name: indexed.game_name,
        camera_type: indexed.camera_type,
        canonical_reference_id: indexed.canonical_reference_id,
      },
    };
  } catch (error) {
    return failure(error, referenceId);
  }
};
