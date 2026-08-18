import { createHash } from "node:crypto";
import { z } from "zod";
import type { KieClaudeGenerateResult, KieClaudeTaskAdapter } from "../models/kie/claude-task";
import {
  conceptPreEvaluationV1Schema,
  type ConceptPreEvaluationV1,
  type CoopGameConceptSpecV1,
  type DiscoveryObjectiveSpecV1,
} from "./schemas";

const preEvaluationBatchSchema = z
  .object({ evaluations: z.array(conceptPreEvaluationV1Schema).min(1).max(16) })
  .strict();

type ConceptPreEvaluatorGenerateResult = Omit<KieClaudeGenerateResult, "usage"> & {
  usage: Partial<KieClaudeGenerateResult["usage"]>;
};

export interface ConceptPreEvaluatorLlm {
  generate: (
    input: Parameters<KieClaudeTaskAdapter["generate"]>[0],
  ) => Promise<ConceptPreEvaluatorGenerateResult>;
}

export interface ConceptPreEvaluationResult {
  evaluations: ConceptPreEvaluationV1[];
  passingConceptIds: string[];
  rejectedConceptIds: string[];
  model: string;
  rawResponseHashes: string[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function extractJsonObject(text: string): string {
  const cleaned = stripCodeFence(text);
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    // tolerate a short provider prefix/suffix; Zod still validates the extracted object strictly
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("CONCEPT_PRE_EVAL_JSON_NOT_FOUND");
  return cleaned.slice(start, end + 1);
}

function addUsage(
  total: ConceptPreEvaluationResult["usage"],
  response: ConceptPreEvaluatorGenerateResult,
): void {
  total.inputTokens += response.usage.inputTokens ?? 0;
  total.outputTokens += response.usage.outputTokens ?? 0;
  total.totalTokens += response.usage.totalTokens ?? 0;
}

function parseBatch(text: string): ConceptPreEvaluationV1[] {
  return preEvaluationBatchSchema.parse(JSON.parse(extractJsonObject(text)) as unknown).evaluations;
}

function schemaInstructions(): string {
  return `Return ONLY JSON: {"evaluations":[...]}. Each evaluation must be exactly:\n{"schema":"concept_pre_evaluation","version":1,"conceptId":"...","coOpDependency":"pass|fail","instantReadability":"pass|fail","buildability":"pass|fail","rejectionReasons":[],"cautionFlags":[],"metadata":{}}.\nIf any gate fails, rejectionReasons must contain a concise concrete reason. Do not invent an overall score.`;
}

function prompt(objective: DiscoveryObjectiveSpecV1, concepts: CoopGameConceptSpecV1[]): string {
  return `Pre-evaluate these accepted co-op game concepts before any paid image/video generation.\n\nDISCOVERY OBJECTIVE:\n${JSON.stringify(objective, null, 2)}\n\nCONCEPTS:\n${JSON.stringify(concepts, null, 2)}\n\nUse exactly three gates:\n1. coOpDependency: fail if another player is optional, cosmetic, or can be replaced without changing the central mechanic.\n2. instantReadability: fail if the core dependency and consequence cannot plausibly be shown and understood in a few seconds of gameplay evidence.\n3. buildability: fail if a small-team PC MVP clearly conflicts with the objective constraints or requires excessive networking/physics/content/NPC-AI scope.\nNovelty is NOT scored here; Diversity Guard already handled it. Settings and art cannot rescue a weak mechanic. Be conservative but do not fail merely because an idea is unusual.\n\n${schemaInstructions()}`;
}

const complexityRank = { low: 0, medium: 1, high: 2 } as const;
const npcAiRank = { none: 0, light: 1, heavy: 2 } as const;

function enforceObjectiveConstraints(
  objective: DiscoveryObjectiveSpecV1,
  concept: CoopGameConceptSpecV1,
  evaluation: ConceptPreEvaluationV1,
): ConceptPreEvaluationV1 {
  const reasons = [...evaluation.rejectionReasons];
  let buildability = evaluation.buildability;

  const networkingCap = objective.constraints.networkingComplexity;
  if (
    networkingCap &&
    complexityRank[concept.buildability.networking] > complexityRank[networkingCap]
  ) {
    buildability = "fail";
    reasons.push(`networking_complexity_exceeds_objective:${networkingCap}`);
  }

  const contentCap = objective.constraints.contentBurden;
  if (
    contentCap &&
    complexityRank[concept.buildability.contentBurden] > complexityRank[contentCap]
  ) {
    buildability = "fail";
    reasons.push(`content_burden_exceeds_objective:${contentCap}`);
  }

  const npcAiCap = objective.constraints.npcAiDependency;
  if (
    npcAiCap === "avoid" &&
    npcAiRank[concept.buildability.npcAiDependency] > npcAiRank.none
  ) {
    buildability = "fail";
    reasons.push("npc_ai_dependency_violates_objective:avoid");
  } else if (
    npcAiCap === "allow_light" &&
    npcAiRank[concept.buildability.npcAiDependency] > npcAiRank.light
  ) {
    buildability = "fail";
    reasons.push("npc_ai_dependency_violates_objective:allow_light");
  }

  return {
    ...evaluation,
    buildability,
    rejectionReasons: [...new Set(reasons)],
  };
}

export async function preEvaluateConcepts(input: {
  llm: ConceptPreEvaluatorLlm;
  objective: DiscoveryObjectiveSpecV1;
  concepts: CoopGameConceptSpecV1[];
  model?: string;
  signal?: AbortSignal;
}): Promise<ConceptPreEvaluationResult> {
  if (!input.concepts.length) throw new Error("CONCEPT_PRE_EVAL_EMPTY_BATCH");

  const model = input.model ?? "claude-haiku-4-5";
  const hashes: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const first = await input.llm.generate({
    model,
    system:
      "You are the cheap product gate inside an AI Co-op Game Discovery Factory. Evaluate game mechanics, not prose quality or visual polish. Return strict structured data only.",
    prompt: prompt(input.objective, input.concepts),
    maxTokens: 4096,
    thinking: false,
    signal: input.signal,
  });
  hashes.push(stableHash(first.text));
  addUsage(usage, first);

  let parsed: ConceptPreEvaluationV1[];
  try {
    parsed = parseBatch(first.text);
  } catch (firstError) {
    const repair = await input.llm.generate({
      model,
      system: "Repair JSON/schema only. Preserve the evaluator decisions. Return JSON only.",
      prompt: `Repair this response into one valid evaluation for every listed concept ID.\nConcept IDs: ${JSON.stringify(input.concepts.map((c) => c.conceptId))}\n\nINVALID RESPONSE:\n${first.text}\n\n${schemaInstructions()}`,
      maxTokens: 4096,
      thinking: false,
      signal: input.signal,
    });
    hashes.push(stableHash(repair.text));
    addUsage(usage, repair);
    try {
      parsed = parseBatch(repair.text);
    } catch (repairError) {
      throw new Error(
        `CONCEPT_PRE_EVAL_SCHEMA_INVALID: ${repairError instanceof Error ? repairError.message : String(repairError)}; first=${firstError instanceof Error ? firstError.message : String(firstError)}`,
      );
    }
  }

  const expectedIds = new Set(input.concepts.map((concept) => concept.conceptId));
  const byId = new Map<string, ConceptPreEvaluationV1>();
  for (const evaluation of parsed) {
    if (!expectedIds.has(evaluation.conceptId)) {
      throw new Error(`CONCEPT_PRE_EVAL_UNKNOWN_ID:${evaluation.conceptId}`);
    }
    if (byId.has(evaluation.conceptId)) {
      throw new Error(`CONCEPT_PRE_EVAL_DUPLICATE_ID:${evaluation.conceptId}`);
    }
    byId.set(evaluation.conceptId, evaluation);
  }
  if (byId.size !== expectedIds.size) {
    throw new Error(`CONCEPT_PRE_EVAL_COUNT_MISMATCH:${byId.size}/${expectedIds.size}`);
  }

  const evaluations = input.concepts.map((concept) =>
    enforceObjectiveConstraints(input.objective, concept, byId.get(concept.conceptId)!),
  );
  const passingConceptIds = evaluations
    .filter(
      (evaluation) =>
        evaluation.coOpDependency === "pass" &&
        evaluation.instantReadability === "pass" &&
        evaluation.buildability === "pass",
    )
    .map((evaluation) => evaluation.conceptId);
  const passing = new Set(passingConceptIds);
  const rejectedConceptIds = evaluations
    .filter((evaluation) => !passing.has(evaluation.conceptId))
    .map((evaluation) => evaluation.conceptId);

  return {
    evaluations,
    passingConceptIds,
    rejectedConceptIds,
    model,
    rawResponseHashes: hashes,
    usage,
  };
}

/** @deprecated Use preEvaluateConcepts. Kept for Stage 4 fixture/backward compatibility. */
export const evaluateConcepts = preEvaluateConcepts;
