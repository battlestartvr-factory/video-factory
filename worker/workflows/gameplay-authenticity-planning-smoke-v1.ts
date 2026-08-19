import {
  gameplayAuthenticitySpecFromShot,
  buildGameplayVideoMotionPlan,
} from "../../lib/game-discovery/gameplay-authenticity";
import {
  stage4GameplayReferenceSetSchema,
  type Stage4GameplayReferenceSet,
} from "../../lib/game-discovery/gameplay-reference-stage4";
import { compileGameplayPromptPlan } from "../../lib/game-discovery/prompt-compiler";
import { planGameplayShots, type DiscoveryFeedbackMemory } from "../../lib/game-discovery/shot-planner";
import {
  coopGameConceptSpecV1Schema,
  discoveryObjectiveSpecV1Schema,
  gameplayMomentSpecV1Schema,
} from "../../lib/game-discovery/schemas";
import type { WorkflowTickHandler } from "./types";

function internalBaseUrl(): string {
  return (process.env.WORKER_APP_INTERNAL_URL ?? "http://app:3000").trim() || "http://app:3000";
}

function serviceToken(): string {
  const token = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? "").trim();
  if (!token) throw new Error("GAMEPLAY_AUTHENTICITY_PLANNING_SMOKE_SERVICE_TOKEN_MISSING");
  return token;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function feedbackMemory(state: Record<string, unknown>): DiscoveryFeedbackMemory {
  const raw =
    state.feedback_memory && typeof state.feedback_memory === "object" && !Array.isArray(state.feedback_memory)
      ? (state.feedback_memory as Record<string, unknown>)
      : {};
  return {
    mustShow: textArray(raw.mustShow ?? raw.must_show),
    mustAvoid: textArray(raw.mustAvoid ?? raw.must_avoid),
    errorTags: textArray(raw.errorTags ?? raw.error_tags),
  };
}

async function retrieveReferenceSet(input: {
  concept: unknown;
  moment: unknown;
  shot: unknown;
  signal: AbortSignal;
}): Promise<Stage4GameplayReferenceSet> {
  const response = await fetch(`${internalBaseUrl()}/api/internal/gameplay-reference-stage4`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "retrieve",
      concept: input.concept,
      moment: input.moment,
      shot: input.shot,
    }),
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
    // Keep a deterministic error surface and never persist an upstream HTML response.
  }
  if (!response.ok || payload.ok !== true || !payload.data?.referenceSet) {
    throw new Error(
      `${payload.code ?? "GAMEPLAY_AUTHENTICITY_PLANNING_SMOKE_RETRIEVAL_FAILED"}:${payload.message ?? response.status}`,
    );
  }
  return stage4GameplayReferenceSetSchema.parse(payload.data.referenceSet);
}

export const gameplayAuthenticityPlanningSmokeV1: WorkflowTickHandler = async (context) => {
  try {
    if (!context.services?.kieClaude) {
      throw new Error("GAMEPLAY_AUTHENTICITY_PLANNING_SMOKE_LLM_MISSING");
    }
    const objective = discoveryObjectiveSpecV1Schema.parse(context.state.objective);
    const concept = coopGameConceptSpecV1Schema.parse(context.state.concept);
    const moment = gameplayMomentSpecV1Schema.parse(context.state.moment);
    if (moment.conceptId !== concept.conceptId) {
      throw new Error("GAMEPLAY_AUTHENTICITY_PLANNING_SMOKE_LINEAGE_MISMATCH");
    }
    const feedback = feedbackMemory(context.state);

    const planning = await planGameplayShots({
      llm: context.services.kieClaude,
      objective,
      concepts: [concept],
      moments: [moment],
      feedbackMemory: feedback,
      signal: context.signal,
    });
    const shot = planning.shots[0];
    if (!shot) throw new Error("GAMEPLAY_AUTHENTICITY_PLANNING_SMOKE_SHOT_MISSING");

    const authenticity = gameplayAuthenticitySpecFromShot(shot);
    if (!authenticity.passed) {
      throw new Error(
        `GAMEPLAY_AUTHENTICITY_PLANNING_SMOKE_GATE_FAILED:${authenticity.hardFailures.join(",") || authenticity.averageScore}`,
      );
    }
    const motionPlan = buildGameplayVideoMotionPlan(shot, authenticity);
    if (!motionPlan.passed || !motionPlan.couldBeRecordedByPlayer) {
      throw new Error(
        `GAMEPLAY_AUTHENTICITY_PLANNING_SMOKE_VIDEO_GATE_FAILED:${motionPlan.gateFailures.join(",")}`,
      );
    }

    const referenceSet = await retrieveReferenceSet({
      concept,
      moment,
      shot,
      signal: context.signal,
    });
    const promptPlan = compileGameplayPromptPlan({
      concept,
      moment,
      shot,
      feedbackMemory: feedback,
      gameplayReferences: referenceSet,
    });

    return {
      status: "completed",
      currentStage: "gameplay_authenticity_planning_smoke_completed",
      progress: 100,
      state: {
        ...context.state,
        provider_calls_allowed: 0,
        image_video_provider_calls_made: 0,
        gameplay_shot: shot,
        gameplay_authenticity: authenticity,
        gameplay_video_motion_plan: motionPlan,
        gameplay_reference_set: referenceSet,
        prompt_plan: promptPlan,
      },
      result: {
        provider_calls_allowed: 0,
        image_video_provider_calls_made: 0,
        planner_model: planning.model,
        planner_repair_model: planning.repairModel,
        planner_escalated: planning.escalated,
        planner_usage: planning.usage,
        shot,
        authenticity,
        motion_plan: motionPlan,
        reference_set: referenceSet,
        prompt_plan: promptPlan,
      },
      stateReason: "gameplay_authenticity_planning_smoke_completed_without_generation",
      eventType: "gameplay_authenticity.planning_smoke_completed",
      eventPayload: {
        image_video_provider_calls_made: 0,
        shot_id: shot.shotId,
        authenticity_score: authenticity.averageScore,
        reference_count: referenceSet.references.length,
        reference_purposes: referenceSet.references.map((item) => item.purpose),
        planner_model: planning.model,
        planner_escalated: planning.escalated,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      currentStage: "gameplay_authenticity_planning_smoke_failed",
      progress: 100,
      state: {
        ...context.state,
        provider_calls_allowed: 0,
        image_video_provider_calls_made: 0,
      },
      error: {
        code: message.split(":", 1)[0] || "GAMEPLAY_AUTHENTICITY_PLANNING_SMOKE_FAILED",
        message: message.slice(0, 2_000),
        retryable: false,
      },
      stateReason: "gameplay_authenticity_planning_smoke_failed_without_generation",
      eventType: "gameplay_authenticity.planning_smoke_failed",
      eventPayload: { image_video_provider_calls_made: 0, error: message.slice(0, 2_000) },
    };
  }
};
