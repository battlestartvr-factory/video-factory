import { createHash } from "node:crypto";
import { z } from "zod";
import type { KieClaudeGenerateResult, KieClaudeTaskAdapter } from "../models/kie/claude-task";
import { assessConceptDiversity, type DiversityAssessment } from "./diversity";
import { getDiscoveryLlmPolicy } from "./model-policy";
import {
  coopGameConceptSpecV1Schema,
  type CoopGameConceptSpecV1,
  type DiscoveryObjectiveSpecV1,
} from "./schemas";

const conceptBatchSchema = z
  .object({
    concepts: z.array(coopGameConceptSpecV1Schema).min(1).max(16),
  })
  .strict();

const DEFAULT_REPLACEMENT_BUFFER = 2;
const MAX_REPLACEMENT_ATTEMPTS = 3;
const MAX_HISTORY_IN_PROMPT = 40;
// A full CoopGameConceptSpec is intentionally detailed. Asking Sonnet for 8 of them
// in one response exceeded KIE's practical gateway window in production (~110s -> 500).
// Keep each provider turn small while preserving the same total exploration target.
export const MAX_CONCEPTS_PER_PROVIDER_CALL = 3;

export interface ConceptExplorerLlm {
  generate: KieClaudeTaskAdapter["generate"];
}

export interface ConceptRejectionRecord {
  conceptId: string;
  source: "initial" | "replacement";
  attempt: number;
  reasons: string[];
  nearestConceptId: string | null;
  underexploredAxes: string[];
  concept: CoopGameConceptSpecV1;
}

export interface ConceptExplorerResult {
  accepted: CoopGameConceptSpecV1[];
  rejected: ConceptRejectionRecord[];
  requestedCount: number;
  generatedCount: number;
  replacementAttempts: number;
  model: string;
  rawResponseHashes: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compactConcept(concept: CoopGameConceptSpecV1): Record<string, unknown> {
  return {
    conceptId: concept.conceptId,
    pitch: concept.oneSentencePitch,
    coreMechanic: concept.coreMechanic,
    coopDependency: concept.coopDependency,
    socialMoment: concept.socialMoment,
    failureMode: concept.failureMode,
    camera: concept.camera,
    noveltyAxes: concept.noveltyAxes.map((axis) => ({ axis: axis.axis, choice: axis.choice })),
    buildability: concept.buildability,
  };
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
    // Continue with a balanced-brace extraction. This tolerates a short prose prefix/suffix
    // without weakening the typed schema that validates the actual payload.
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < cleaned.length; index += 1) {
    const char = cleaned[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (start === -1) start = index;
      depth += 1;
    } else if (char === "}" && start !== -1) {
      depth -= 1;
      if (depth === 0) return cleaned.slice(start, index + 1);
    }
  }
  throw new Error("CONCEPT_EXPLORER_JSON_NOT_FOUND");
}

function parseConceptBatch(text: string): CoopGameConceptSpecV1[] {
  const json = JSON.parse(extractJsonObject(text)) as unknown;
  return conceptBatchSchema.parse(json).concepts;
}

function schemaInstructions(): string {
  return `Return ONLY one JSON object with this exact top-level shape: {"concepts":[...]}.\nEvery concept MUST satisfy CoopGameConceptSpec v1 with these fields:\n- schema: "coop_game_concept", version: 1, conceptId\n- oneSentencePitch, coreMechanic, coopDependency\n- playerRoles: [{role,responsibility,information?,power?}]\n- playerCount: {min,max,ideal}, all integers 2..4\n- interactionModel: string[]\n- failureMode, socialMoment, gameplayHook, spectacle, setting, artDirection, camera, readability\n- noveltyAxes: at least 2 [{axis,choice,whyDifferent}]\n- buildability: {networking,physics,contentBurden,npcAiDependency,systemicInteractions,mainRisks,mvpRead}\n  networking/physics/contentBurden/systemicInteractions are low|medium|high; npcAiDependency is none|light|heavy\n- referenceInfluences: [{reference,borrowedPrinciple,mustNotCopy}] or []\n- optional metadata object.\nUse stable, concise kebab-case conceptId values unique inside this response.`;
}

function objectivePrompt(
  objective: DiscoveryObjectiveSpecV1,
  count: number,
  history: CoopGameConceptSpecV1[],
): string {
  const historySlice = history.slice(0, MAX_HISTORY_IN_PROMPT).map(compactConcept);
  return `Generate ${count} substantially different candidate PC/Steam friends co-op game concepts for this discovery objective.\n\nDISCOVERY OBJECTIVE:\n${JSON.stringify(objective, null, 2)}\n\nRECENT PROJECT CONCEPT HISTORY (do not cosmetically re-skin these; use it as negative-space evidence):\n${JSON.stringify(historySlice, null, 2)}\n\nDIVERSITY REQUIREMENTS:\n- Spread the batch across dependency type, social tension, tempo, camera/scale, failure signature, and buildability shape.\n- The second/third player must be mechanically necessary, not merely present.\n- Prefer mechanics whose co-op dependency and failure consequence can be understood in seconds of fake gameplay.\n- Setting/art direction cannot substitute for a distinct mechanic.\n- Respect all objective constraints and forbidden patterns.\n- Early discovery should explore mechanism space rather than cluster around obvious genre archetypes.\n\n${schemaInstructions()}`;
}

function replacementPrompt(input: {
  objective: DiscoveryObjectiveSpecV1;
  rejected: ConceptRejectionRecord;
  accepted: CoopGameConceptSpecV1[];
  history: CoopGameConceptSpecV1[];
}): string {
  return `Generate exactly 1 replacement PC/Steam friends co-op concept. The previous candidate was rejected by the deterministic Diversity Guard.\n\nDISCOVERY OBJECTIVE:\n${JSON.stringify(input.objective, null, 2)}\n\nREJECTED CANDIDATE:\n${JSON.stringify(compactConcept(input.rejected.concept), null, 2)}\n\nEXACT REJECTION REASONS:\n${JSON.stringify(input.rejected.reasons)}\n\nAXES THAT NEED MORE EXPLORATION / CHANGE:\n${JSON.stringify(input.rejected.underexploredAxes)}\n\nALREADY ACCEPTED IN THIS BATCH:\n${JSON.stringify(input.accepted.map(compactConcept), null, 2)}\n\nRECENT HISTORY TO AVOID COPYING:\n${JSON.stringify(input.history.slice(0, 20).map(compactConcept), null, 2)}\n\nDo not repair the old concept by changing only setting or art. Change the mechanical/social structure enough to clear the cited diversity reasons.\n\n${schemaInstructions()}`;
}

const SYSTEM_PROMPT = `You are the Concept Explorer inside an AI Co-op Game Discovery Factory. Your product is not content volume; your job is to explore the design space for a real, buildable PC/Steam friends co-op game. Produce mechanically concrete, visually testable concepts with explicit co-op dependency. Never optimize for pretty lore at the expense of gameplay structure.`;

function addUsage(
  total: ConceptExplorerResult["usage"],
  response: KieClaudeGenerateResult,
): void {
  total.inputTokens += response.usage.inputTokens ?? 0;
  total.outputTokens += response.usage.outputTokens ?? 0;
  total.totalTokens += response.usage.totalTokens ?? 0;
}

async function generateTypedBatch(input: {
  llm: ConceptExplorerLlm;
  model: string;
  prompt: string;
  expectedCount: number;
  signal?: AbortSignal;
  responseHashes: string[];
  usage: ConceptExplorerResult["usage"];
}): Promise<CoopGameConceptSpecV1[]> {
  const explorerPolicy = getDiscoveryLlmPolicy("concept_exploration");
  const repairPolicy = getDiscoveryLlmPolicy("schema_repair");
  const first = await input.llm.generate({
    model: input.model,
    system: SYSTEM_PROMPT,
    prompt: input.prompt,
    maxTokens: explorerPolicy.maxOutputTokens,
    thinking: explorerPolicy.thinking,
    signal: input.signal,
  });
  input.responseHashes.push(stableHash(first.text));
  addUsage(input.usage, first);

  try {
    return parseConceptBatch(first.text);
  } catch (firstError) {
    const repair = await input.llm.generate({
      model: repairPolicy.primaryModel,
      system: `${SYSTEM_PROMPT}\nYou are now doing a schema repair only. Preserve the candidate ideas; fix JSON/schema shape and return only valid JSON.`,
      prompt: `Repair the following response so it contains ${input.expectedCount} valid CoopGameConceptSpec v1 objects when possible. Do not add commentary.\n\nINVALID RESPONSE:\n${first.text}\n\n${schemaInstructions()}`,
      maxTokens: repairPolicy.maxOutputTokens,
      thinking: repairPolicy.thinking,
      signal: input.signal,
    });
    input.responseHashes.push(stableHash(repair.text));
    addUsage(input.usage, repair);
    try {
      return parseConceptBatch(repair.text);
    } catch (repairError) {
      throw new Error(
        `CONCEPT_EXPLORER_SCHEMA_INVALID: ${repairError instanceof Error ? repairError.message : String(repairError)}; first=${firstError instanceof Error ? firstError.message : String(firstError)}`,
      );
    }
  }
}

function rejectionRecord(
  concept: CoopGameConceptSpecV1,
  assessment: DiversityAssessment,
  source: "initial" | "replacement",
  attempt: number,
): ConceptRejectionRecord {
  return {
    conceptId: concept.conceptId,
    source,
    attempt,
    reasons: assessment.rejectionReasons,
    nearestConceptId: assessment.nearest?.referenceConceptId ?? null,
    underexploredAxes: assessment.underexploredAxes,
    concept,
  };
}

export async function exploreConcepts(input: {
  llm: ConceptExplorerLlm;
  objective: DiscoveryObjectiveSpecV1;
  history?: CoopGameConceptSpecV1[];
  model?: string;
  replacementBuffer?: number;
  maxReplacementAttempts?: number;
  signal?: AbortSignal;
}): Promise<ConceptExplorerResult> {
  const explorerPolicy = getDiscoveryLlmPolicy("concept_exploration");
  const model = input.model ?? explorerPolicy.primaryModel;
  const history = input.history ?? [];
  const replacementBuffer = Math.max(0, Math.min(input.replacementBuffer ?? DEFAULT_REPLACEMENT_BUFFER, 4));
  const maxReplacementAttempts = Math.max(
    0,
    Math.min(input.maxReplacementAttempts ?? MAX_REPLACEMENT_ATTEMPTS, 6),
  );
  const responseHashes: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const initialTarget = Math.min(input.objective.conceptCount + replacementBuffer, 16);
  const initial: CoopGameConceptSpecV1[] = [];

  // Generate the same exploration pool as before, but in bounded provider turns. Each
  // later turn sees the previous candidates as negative-space history so chunking does
  // not collapse diversity or become several independent mini-batches.
  while (initial.length < initialTarget) {
    const remaining = initialTarget - initial.length;
    const requested = Math.min(remaining, MAX_CONCEPTS_PER_PROVIDER_CALL);
    const batch = await generateTypedBatch({
      llm: input.llm,
      model,
      prompt: objectivePrompt(input.objective, requested, [...history, ...initial]),
      expectedCount: requested,
      signal: input.signal,
      responseHashes,
      usage,
    });
    initial.push(...batch.slice(0, requested));
  }

  const accepted: CoopGameConceptSpecV1[] = [];
  const rejected: ConceptRejectionRecord[] = [];
  let generatedCount = initial.length;

  const assessAndMaybeAccept = (
    candidate: CoopGameConceptSpecV1,
    source: "initial" | "replacement",
    attempt: number,
  ): ConceptRejectionRecord | null => {
    if (accepted.some((item) => item.conceptId === candidate.conceptId)) {
      const record: ConceptRejectionRecord = {
        conceptId: candidate.conceptId,
        source,
        attempt,
        reasons: [`duplicate_concept_id:${candidate.conceptId}`],
        nearestConceptId: candidate.conceptId,
        underexploredAxes: [],
        concept: candidate,
      };
      rejected.push(record);
      return record;
    }

    const assessment = assessConceptDiversity(candidate, [...accepted, ...history]);
    if (assessment.decision === "accept") {
      accepted.push(candidate);
      return null;
    }
    const record = rejectionRecord(candidate, assessment, source, attempt);
    rejected.push(record);
    return record;
  };

  for (const candidate of initial) {
    if (accepted.length >= input.objective.conceptCount) break;
    assessAndMaybeAccept(candidate, "initial", 0);
  }

  let replacementAttempts = 0;
  while (accepted.length < input.objective.conceptCount && replacementAttempts < maxReplacementAttempts) {
    replacementAttempts += 1;
    const previousRejection = rejected[rejected.length - 1];
    if (!previousRejection) break;

    const replacements = await generateTypedBatch({
      llm: input.llm,
      model,
      prompt: replacementPrompt({
        objective: input.objective,
        rejected: previousRejection,
        accepted,
        history,
      }),
      expectedCount: 1,
      signal: input.signal,
      responseHashes,
      usage,
    });
    generatedCount += replacements.length;

    for (const replacement of replacements.slice(0, 1)) {
      assessAndMaybeAccept(replacement, "replacement", replacementAttempts);
    }
  }

  if (accepted.length < input.objective.conceptCount) {
    throw new Error(
      `CONCEPT_EXPLORER_DIVERSITY_EXHAUSTED: accepted ${accepted.length}/${input.objective.conceptCount} after ${replacementAttempts} replacement attempts`,
    );
  }

  return {
    accepted: accepted.slice(0, input.objective.conceptCount),
    rejected,
    requestedCount: input.objective.conceptCount,
    generatedCount,
    replacementAttempts,
    model,
    rawResponseHashes: responseHashes,
    usage,
  };
}

export { parseConceptBatch };
