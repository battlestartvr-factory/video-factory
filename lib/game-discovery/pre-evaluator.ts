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

export interface ConceptPreEvaluatorLlm {
  generate: KieClaudeTaskAdapter["generate"];
}

export interface ConceptPreEvaluationResult {
  evaluations: ConceptPreEvaluationV1[];
  passingConceptIds: string[];
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
  response: KieClaudeGenerateResult,
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

function enforceObjectiveConstraints(
  objective: DiscoveryObjectiveSpecV1,
  concept: CoopGameConceptSpecV1,
  evaluation: ConceptPreEvaluationV1,
): ConceptPreEvaluationV1 {
  const reasons = [...evaluation.rejectionReasons];
  let buildability = evaluation.buildability;

  if (
    objective.constraints.networkingComplexity === "low" &&
    concept.buildability.networking !== "low"
  ) {
    buildability = "fail";
    reasons.push("networking complexity exceeds objective constraint");
  }
  if (objective.constraints.contentBurden === "low" && concept.buildability.contentBurden !== "low") {
    buildability = "fail";
    reasons.push("content burden exceeds objective constraint");
  }
  if (
    objective.constraints.npcAiDependency === "avoid" &&
    concept.buildability.npcAiDependency !== "none"
  ) {
    buildability = "fail";
    reasons.push("NPC AI dependency violates objective constraint");
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

  return { evaluations, passingConceptIds, model, rawResponseHashes: hashes, usage };
}
