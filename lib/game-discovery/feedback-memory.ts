import { createHash } from "node:crypto";
import { z } from "zod";
import type { KieClaudeTaskAdapter } from "../models/kie/claude-task";
import { getDiscoveryLlmPolicy } from "./model-policy";
import type { DiscoveryFeedbackMemory } from "./shot-planner";

const shortText = z.string().trim().min(1).max(500);

export const gameplayReferenceFeedbackV1Schema = z
  .object({
    schema: z.literal("gameplay_reference_feedback"),
    version: z.literal(1),
    errorTags: z.array(shortText).max(20).default([]),
    mustShow: z.array(shortText).max(30).default([]),
    mustAvoid: z.array(shortText).max(30).default([]),
    reusableScope: z.enum(["shot", "concept", "project"]).default("concept"),
    summary: z.string().trim().min(1).max(2_000),
  })
  .strict();

export type GameplayReferenceFeedbackV1 = z.infer<typeof gameplayReferenceFeedbackV1Schema>;

export interface FeedbackStructuringResult {
  feedback: GameplayReferenceFeedbackV1;
  model: string;
  rawResponseHash: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(fenced);
  } catch {
    const start = fenced.indexOf("{");
    const end = fenced.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("REFERENCE_FEEDBACK_JSON_NOT_FOUND");
    return JSON.parse(fenced.slice(start, end + 1));
  }
}

function clip(value: string, max: number): string {
  const normalized = value.trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function explicitlyReportsGameplayAuthenticityFailure(rawFeedback: string): boolean {
  const normalized = rawFeedback.trim().toLowerCase();
  return [
    /\bnot gameplay\b/,
    /\bdoes(?:n['’]t| not) look like (?:a )?(?:real )?(?:game|gameplay)\b/,
    /\blooks? (?:like )?(?:a )?cinematic(?: scene| shot| video)?\b/,
    /\bspectator camera\b/,
    /\btrailer shot\b/,
    /(?:выглядит|похоже) не как (?:игра|игру|геймплей)/,
    /не (?:выглядит|похоже) как (?:игра|игру|геймплей)/,
    /не похоже на (?:игру|геймплей)/,
    /\bне геймплей\b/,
    /кинематографич/,
    /как (?:трейлер|постановочн(?:ая|ый) сцен)/,
  ].some((pattern) => pattern.test(normalized));
}

export function applyGameplayAuthenticityFeedbackClassification(input: {
  rawFeedback: string;
  feedback: GameplayReferenceFeedbackV1;
}): GameplayReferenceFeedbackV1 {
  if (!explicitlyReportsGameplayAuthenticityFailure(input.rawFeedback)) return input.feedback;
  return gameplayReferenceFeedbackV1Schema.parse({
    ...input.feedback,
    errorTags: [...new Set(["gameplay_authenticity_failure", ...input.feedback.errorTags])],
  });
}

/**
 * Human review must never be lost just because the cheap structuring model is unavailable
 * or emits invalid JSON. Preserve the user's criticism in a bounded schema-valid form so
 * revision can continue without inventing extra preferences.
 */
export function fallbackGameplayReferenceFeedback(input: {
  rawFeedback: string;
  decision: "approve" | "reject" | "revise";
}): GameplayReferenceFeedbackV1 {
  const raw = clip(input.rawFeedback, 500);
  const feedback = gameplayReferenceFeedbackV1Schema.parse({
    schema: "gameplay_reference_feedback",
    version: 1,
    errorTags: [],
    mustShow: input.decision === "revise" && raw ? [raw] : [],
    mustAvoid: input.decision === "reject" && raw ? [raw] : [],
    reusableScope: input.decision === "revise" ? "shot" : "concept",
    summary: clip(input.rawFeedback, 2_000) || "Human review feedback was recorded.",
  });
  return applyGameplayAuthenticityFeedbackClassification({
    rawFeedback: input.rawFeedback,
    feedback,
  });
}

export async function structureGameplayReferenceFeedback(input: {
  llm: Pick<KieClaudeTaskAdapter, "generate">;
  rawFeedback: string;
  decision: "approve" | "reject" | "revise";
  mediaKind?: "reference_image" | "video";
  conceptSummary?: string;
  shotSummary?: string;
  signal?: AbortSignal;
}): Promise<FeedbackStructuringResult> {
  const policy = getDiscoveryLlmPolicy("feedback_structuring");
  const mediaLabel = input.mediaKind === "video" ? "gameplay-video" : "gameplay reference-image";
  const response = await input.llm.generate({
    model: policy.primaryModel,
    system:
      "You structure human review feedback for an AI co-op gameplay factory. The human is the final judge of generated media. Preserve explicit praise and criticism as reusable memory, but never invent preferences or override the human decision.",
    prompt: `Convert this human ${mediaLabel} review into structured factory memory.\n\nDECISION: ${input.decision}\nMEDIA: ${input.mediaKind ?? "reference_image"}\nCONCEPT: ${input.conceptSummary ?? "not provided"}\nSHOT: ${input.shotSummary ?? "not provided"}\nRAW USER FEEDBACK:\n${input.rawFeedback}\n\nReturn ONLY JSON with schema gameplay_reference_feedback version 1 and fields errorTags, mustShow, mustAvoid, reusableScope, summary.\n- errorTags: concise machine-readable obvious failure categories such as gameplay_authenticity_failure, coop_dependency_not_visible, wrong_camera, too_cinematic, unreadable_consequence. Use only failures supported by the feedback. If the user explicitly says the result does not look like a game/gameplay or reads as cinematic/trailer/spectator instead of active gameplay, gameplay_authenticity_failure is REQUIRED.\n- mustShow: future visible requirements clearly requested by the user. For an APPROVE decision, also preserve a clearly praised visible trait here when the user explicitly says why they like it.\n- mustAvoid: concrete rejected patterns that should not be repeated. Even when DECISION is APPROVE, put any explicit criticism or unwanted detail from the comment here instead of ignoring it.\n- reusableScope: shot for local correction, concept for this game idea, project only for a clearly general preference/rule.\n- summary: faithful compact paraphrase of both praise and criticism and why the human made this decision.\nDo not turn vague praise such as "nice" into a hard visual rule. Do not infer a project-wide rule from a one-off aesthetic comment.`,
    maxTokens: policy.maxOutputTokens,
    thinking: policy.thinking,
    signal: input.signal,
  });

  const feedback = applyGameplayAuthenticityFeedbackClassification({
    rawFeedback: input.rawFeedback,
    feedback: gameplayReferenceFeedbackV1Schema.parse(extractJson(response.text)),
  });
  return {
    feedback,
    model: policy.primaryModel,
    rawResponseHash: hash(response.text),
    usage: {
      inputTokens: response.usage.inputTokens ?? 0,
      outputTokens: response.usage.outputTokens ?? 0,
      totalTokens: response.usage.totalTokens ?? 0,
    },
  };
}

export function mergeFeedbackMemory(items: GameplayReferenceFeedbackV1[]): DiscoveryFeedbackMemory {
  const mustShow = new Set<string>();
  const mustAvoid = new Set<string>();
  const errorTags = new Set<string>();
  for (const item of items) {
    item.mustShow.forEach((value) => mustShow.add(value));
    item.mustAvoid.forEach((value) => mustAvoid.add(value));
    item.errorTags.forEach((value) => errorTags.add(value));
  }
  return {
    mustShow: [...mustShow],
    mustAvoid: [...mustAvoid],
    errorTags: [...errorTags],
  };
}
