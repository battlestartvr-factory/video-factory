import "server-only";

import { canonicalizeHumanFeedback } from "@/lib/i18n/human-feedback";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getGameDiscoveryBatch } from "./service";

export type GameplayConceptReviewDecision = "approve" | "reject" | "revise";

export interface GameplayConceptReview {
  id: string;
  root_creative_run_id: string;
  concept_run_id: string;
  user_id: string | null;
  concept_id: string;
  decision: GameplayConceptReviewDecision;
  raw_feedback: string | null;
  structured_feedback: Record<string, unknown>;
  created_at: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function listGameplayConceptReviews(input: {
  userId: string;
  rootRunId: string;
}): Promise<GameplayConceptReview[]> {
  const root = await getGameDiscoveryBatch({ userId: input.userId, runId: input.rootRunId });
  if (!root) throw new Error("FORBIDDEN");

  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("gameplay_concept_reviews")
    .select("*")
    .eq("root_creative_run_id", input.rootRunId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to list gameplay concept reviews: ${error.message}`);
  return (data ?? []) as GameplayConceptReview[];
}

export async function recordGameplayConceptReview(input: {
  userId: string;
  rootRunId: string;
  conceptRunId: string;
  conceptId: string;
  decision: GameplayConceptReviewDecision;
  rawFeedback?: string | null;
}): Promise<GameplayConceptReview> {
  const root = await getGameDiscoveryBatch({ userId: input.userId, runId: input.rootRunId });
  if (!root) throw new Error("FORBIDDEN");

  const rawFeedback = input.rawFeedback?.trim() ?? "";
  if (input.decision !== "approve" && !rawFeedback) {
    throw new Error("FEEDBACK_REQUIRED");
  }

  const canonical = rawFeedback ? await canonicalizeHumanFeedback(rawFeedback) : null;
  const canonicalSummary = canonical?.canonicalEnglish ||
    (input.decision === "approve"
      ? "Concept approved by human without additional changes."
      : "Human concept review recorded.");

  const structuredFeedback: Record<string, unknown> = {
    schema: "gameplay_concept_feedback",
    version: 1,
    decision: input.decision,
    summary: canonicalSummary,
    originalLocale: canonical?.originalLocale ?? null,
    originalText: canonical?.originalText ?? null,
    canonicalEnglish: canonical?.canonicalEnglish ?? canonicalSummary,
    translation: canonical
      ? {
          translated: canonical.translated,
          model: canonical.translationModel,
          usage: canonical.translationUsage,
          fallback: canonical.translationFallback,
        }
      : null,
    intent:
      input.decision === "approve"
        ? "preserve_and_continue"
        : input.decision === "revise"
          ? "revise_same_concept"
          : "replace_with_fundamentally_new_concept",
    replacementContract:
      input.decision === "reject"
        ? {
            reskinForbidden: true,
            mustChange: [
              "core_mechanic",
              "coop_dependency",
              "player_actions",
              "failure_signature",
              "social_moment",
            ],
          }
        : null,
  };

  const service = createSupabaseServiceClient();
  const { data, error } = await service.rpc("orchestrator_record_gameplay_concept_review", {
    payload: {
      root_creative_run_id: input.rootRunId,
      concept_run_id: input.conceptRunId,
      user_id: input.userId,
      concept_id: input.conceptId,
      decision: input.decision,
      raw_feedback: rawFeedback || null,
      structured_feedback: structuredFeedback,
    },
  });
  if (error) throw new Error(`Failed to record gameplay concept review: ${error.message}`);
  const review = object(object(data).review);
  if (typeof review.id !== "string") throw new Error("Invalid gameplay concept review response");
  return review as unknown as GameplayConceptReview;
}
