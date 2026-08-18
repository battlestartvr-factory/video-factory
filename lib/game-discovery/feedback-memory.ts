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

export async function structureGameplayReferenceFeedback(input: {
  llm: Pick<KieClaudeTaskAdapter, "generate">;
  rawFeedback: string;
  decision: "approve" | "reject" | "revise";
  conceptSummary?: string;
  shotSummary?: string;
  signal?: AbortSignal;
}): Promise<FeedbackStructuringResult> {
  const policy = getDiscoveryLlmPolicy("feedback_structuring");
  const response = await input.llm.generate({
    model: policy.primaryModel,
    system:
      "You structure human review feedback for an AI co-op gameplay factory. Preserve explicit criticism. Extract durable constraints only when the user clearly said or strongly implied them. Never invent preferences.",
    prompt: `Convert this gameplay reference-image review into structured memory.\n\nDECISION: ${input.decision}\nCONCEPT: ${input.conceptSummary ?? "not provided"}\nSHOT: ${input.shotSummary ?? "not provided"}\nRAW USER FEEDBACK:\n${input.rawFeedback}\n\nReturn ONLY JSON with schema gameplay_reference_feedback version 1 and fields errorTags, mustShow, mustAvoid, reusableScope, summary.\n- errorTags: concise machine-readable obvious failure categories such as coop_dependency_not_visible, wrong_camera, too_cinematic, unreadable_consequence. Use only failures supported by the feedback.\n- mustShow: future visible requirements clearly requested by the user.\n- mustAvoid: concrete rejected patterns that should not be repeated.\n- reusableScope: shot for local correction, concept for this game idea, project only for a clearly general preference/rule.\n- summary: faithful compact paraphrase of the feedback.\nDo not infer a project-wide rule from a one-off aesthetic comment.`,
    maxTokens: policy.maxOutputTokens,
    thinking: policy.thinking,
    signal: input.signal,
  });

  const feedback = gameplayReferenceFeedbackV1Schema.parse(extractJson(response.text));
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
