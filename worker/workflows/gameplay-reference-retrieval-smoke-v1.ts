import {
  stage4GameplayReferenceSetSchema,
  type Stage4GameplayReferenceSet,
} from "../../lib/game-discovery/gameplay-reference-stage4";
import {
  coopGameConceptSpecV1Schema,
  gameplayMomentSpecV1Schema,
  shotSpecV1Schema,
} from "../../lib/game-discovery/schemas";
import type { WorkflowTickHandler } from "./types";

function internalBaseUrl(): string {
  return (process.env.WORKER_APP_INTERNAL_URL ?? "http://app:3000").trim() || "http://app:3000";
}

function serviceToken(): string {
  const token = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? "").trim();
  if (!token) throw new Error("GAMEPLAY_REFERENCE_RETRIEVAL_SMOKE_SERVICE_TOKEN_MISSING");
  return token;
}

async function retrieve(input: {
  concept: unknown;
  moment: unknown;
  shot: unknown;
  signal: AbortSignal;
}): Promise<Stage4GameplayReferenceSet> {
  const concept = coopGameConceptSpecV1Schema.parse(input.concept);
  const moment = gameplayMomentSpecV1Schema.parse(input.moment);
  const shot = shotSpecV1Schema.parse(input.shot);
  const response = await fetch(`${internalBaseUrl()}/api/internal/gameplay-reference-stage4`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "retrieve", concept, moment, shot }),
    signal: input.signal,
  });
  const raw = await response.text();
  let payload: {
    ok?: boolean;
    code?: string;
    message?: string;
    data?: { referenceSet?: unknown };
  } = {};
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    // Keep a deterministic error surface; never store an upstream HTML body.
  }
  if (!response.ok || payload.ok !== true || !payload.data?.referenceSet) {
    throw new Error(
      `${payload.code ?? "GAMEPLAY_REFERENCE_RETRIEVAL_SMOKE_UPSTREAM_FAILED"}:${payload.message ?? response.status}`,
    );
  }
  return stage4GameplayReferenceSetSchema.parse(payload.data.referenceSet);
}

export const gameplayReferenceRetrievalSmokeV1: WorkflowTickHandler = async (context) => {
  try {
    const referenceSet = await retrieve({
      concept: context.state.concept,
      moment: context.state.moment,
      shot: context.state.shot,
      signal: context.signal,
    });
    return {
      status: "completed",
      currentStage: "retrieval_smoke_completed",
      progress: 100,
      state: {
        ...context.state,
        provider_calls_allowed: 0,
        provider_calls_made: 0,
        reference_set: referenceSet,
      },
      result: {
        provider_calls_made: 0,
        reference_count: referenceSet.references.length,
        purposes: referenceSet.references.map((item) => item.purpose),
        references: referenceSet.references,
      },
      stateReason: "gameplay_reference_retrieval_smoke_completed_without_generation",
      eventType: "gameplay_reference.retrieval_smoke_completed",
      eventPayload: {
        provider_calls_made: 0,
        reference_count: referenceSet.references.length,
        references: referenceSet.references.map((item) => ({
          reference_id: item.referenceId,
          purpose: item.purpose,
          game_name: item.gameName,
          score: item.score,
        })),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      currentStage: "retrieval_smoke_failed",
      progress: 100,
      state: {
        ...context.state,
        provider_calls_allowed: 0,
        provider_calls_made: 0,
      },
      error: {
        code: message.split(":", 1)[0] || "GAMEPLAY_REFERENCE_RETRIEVAL_SMOKE_FAILED",
        message: message.slice(0, 2_000),
        retryable: false,
      },
      stateReason: "gameplay_reference_retrieval_smoke_failed_without_generation",
      eventType: "gameplay_reference.retrieval_smoke_failed",
      eventPayload: { provider_calls_made: 0, error: message.slice(0, 2_000) },
    };
  }
};
