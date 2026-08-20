import { createHash } from "node:crypto";
import { z } from "zod";
import type { KieClaudeGenerateResult, KieClaudeTaskAdapter } from "../models/kie/claude-task";
import { getDiscoveryLlmPolicy } from "./model-policy";
import {
  coopGameConceptSpecV1Schema,
  type CoopGameConceptSpecV1,
  type DiscoveryObjectiveSpecV1,
} from "./schemas";

export type HumanConceptDecision = "approve" | "revise" | "reject";

export interface HumanConceptReviewState {
  conceptRunId: string;
  conceptId: string;
  decision: HumanConceptDecision;
  rawFeedback: string | null;
  reviewId: string | null;
}

export interface HumanConceptGateLlm {
  generate: KieClaudeTaskAdapter["generate"];
}

export interface HumanConceptGateResult {
  activeConcepts: CoopGameConceptSpecV1[];
  regeneratedConcepts: CoopGameConceptSpecV1[];
  model: string;
  rawResponseHashes: string[];
  attempts: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

const conceptEnvelopeSchema = z.object({ concept: coopGameConceptSpecV1Schema }).strict();
const MAX_REGENERATION_ATTEMPTS = 3;

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
    // A short provider prose prefix/suffix is tolerated; the extracted payload is still schema-validated.
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
  throw new Error("HUMAN_CONCEPT_GATE_JSON_NOT_FOUND");
}

function parseConcept(text: string): CoopGameConceptSpecV1 {
  const parsed = JSON.parse(extractJsonObject(text)) as unknown;
  const envelope = conceptEnvelopeSchema.safeParse(parsed);
  if (envelope.success) return envelope.data.concept;
  return coopGameConceptSpecV1Schema.parse(parsed);
}

function addUsage(total: HumanConceptGateResult["usage"], response: KieClaudeGenerateResult): void {
  total.inputTokens += response.usage.inputTokens ?? 0;
  total.outputTokens += response.usage.outputTokens ?? 0;
  total.totalTokens += response.usage.totalTokens ?? 0;
}

function schemaInstructions(): string {
  return `Return ONLY JSON with this top-level shape: {"concept":{...}}. The concept MUST satisfy CoopGameConceptSpec v1 exactly:\n- schema: "coop_game_concept"; version: 1; conceptId: concise kebab-case string\n- oneSentencePitch, coreMechanic, coopDependency, failureMode, socialMoment, gameplayHook, spectacle, setting, artDirection, camera, readability: strings\n- playerRoles: 1..8 objects {role,responsibility,information?,power?}; optional information/power are strings\n- playerCount: {min,max,ideal}, all integers 2..4\n- interactionModel: non-empty string[]\n- noveltyAxes: at least 2 objects {axis,choice,whyDifferent}\n- buildability: {networking:"low"|"medium"|"high",physics:"low"|"medium"|"high",contentBurden:"low"|"medium"|"high",npcAiDependency:"none"|"light"|"heavy",systemicInteractions:"low"|"medium"|"high",mainRisks:string[],mvpRead:string}\n- referenceInfluences: array (or []) of {reference,borrowedPrinciple,mustNotCopy}\n- metadata: optional object.`;
}

function compactConcept(concept: CoopGameConceptSpecV1): Record<string, unknown> {
  return {
    conceptId: concept.conceptId,
    pitch: concept.oneSentencePitch,
    coreMechanic: concept.coreMechanic,
    coopDependency: concept.coopDependency,
    playerRoles: concept.playerRoles,
    interactionModel: concept.interactionModel,
    failureMode: concept.failureMode,
    socialMoment: concept.socialMoment,
    gameplayHook: concept.gameplayHook,
    setting: concept.setting,
    artDirection: concept.artDirection,
    camera: concept.camera,
    readability: concept.readability,
    buildability: concept.buildability,
  };
}

function tokenSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3),
  );
}

function jaccard(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size && !b.size) return 1;
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

/**
 * Reject means replacement, never a cosmetic reskin. A replacement must materially
 * change at least four of the five mechanism/social dimensions below.
 */
export function isMateriallyNewConcept(
  rejected: CoopGameConceptSpecV1,
  replacement: CoopGameConceptSpecV1,
): boolean {
  const dimensions: Array<[string, string]> = [
    [rejected.coreMechanic, replacement.coreMechanic],
    [rejected.coopDependency, replacement.coopDependency],
    [rejected.interactionModel.join(" "), replacement.interactionModel.join(" ")],
    [rejected.failureMode, replacement.failureMode],
    [rejected.socialMoment, replacement.socialMoment],
  ];
  const materiallyChanged = dimensions.filter(([before, after]) => jaccard(before, after) < 0.62).length;
  return materiallyChanged >= 4;
}

function lineageConceptId(input: {
  candidateId: string;
  sourceId: string;
  decision: "revise" | "reject";
  feedback: string;
  attempt: number;
  occupied: Set<string>;
}): string {
  const suffix = stableHash(
    `${input.sourceId}:${input.decision}:${input.feedback}:${input.attempt}:${input.candidateId}`,
  ).slice(0, 8);
  const baseRaw = input.decision === "revise" ? input.sourceId : input.candidateId;
  const base = baseRaw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 140) || "concept";
  const marker = input.decision === "revise" ? "rev" : "new";
  let next = `${base}-${marker}-${suffix}`.slice(0, 160);
  if (input.occupied.has(next) || next === input.sourceId) {
    next = `${base.slice(0, 130)}-${marker}-${suffix}-${input.attempt}`.slice(0, 160);
  }
  return next;
}

function withLineage(input: {
  candidate: CoopGameConceptSpecV1;
  source: CoopGameConceptSpecV1;
  review: HumanConceptReviewState;
  attempt: number;
  occupied: Set<string>;
}): CoopGameConceptSpecV1 {
  const feedback = input.review.rawFeedback?.trim() ?? "";
  const conceptId = lineageConceptId({
    candidateId: input.candidate.conceptId,
    sourceId: input.source.conceptId,
    decision: input.review.decision === "reject" ? "reject" : "revise",
    feedback,
    attempt: input.attempt,
    occupied: input.occupied,
  });
  return coopGameConceptSpecV1Schema.parse({
    ...input.candidate,
    conceptId,
    metadata: {
      ...(input.candidate.metadata ?? {}),
      humanReviewLineage: {
        action: input.review.decision === "reject" ? "replace" : "revise",
        sourceConceptId: input.source.conceptId,
        sourceConceptRunId: input.review.conceptRunId,
        sourceReviewId: input.review.reviewId ?? null,
        humanFeedback: feedback,
      },
    },
  });
}

function revisionPrompt(input: {
  objective: DiscoveryObjectiveSpecV1;
  concept: CoopGameConceptSpecV1;
  feedback: string;
}): string {
  return `Revise ONE existing PC/Steam friends co-op game concept according to authoritative human feedback. This is a REVISION, not a replacement: preserve the recognizable game idea and its strongest uncriticized design decisions, while changing exactly what the human asked to change. Do not continue to gameplay planning.\n\nDISCOVERY OBJECTIVE:\n${JSON.stringify(input.objective, null, 2)}\n\nCURRENT CONCEPT:\n${JSON.stringify(input.concept, null, 2)}\n\nHUMAN FEEDBACK — AUTHORITATIVE:\n${input.feedback}\n\nRules:\n- Preserve the core identity unless the feedback explicitly asks to alter part of it.\n- Make requested mechanic, co-op, game-design, setting, art or readability changes concrete.\n- Do not merely explain changes; return the complete revised concept.\n- Keep the game buildable and mechanically necessary for 2–4 friends.\n- Use a fresh conceptId because this is a new immutable version.\n\n${schemaInstructions()}`;
}

function replacementPrompt(input: {
  objective: DiscoveryObjectiveSpecV1;
  rejected: CoopGameConceptSpecV1;
  feedback: string;
  approved: CoopGameConceptSpecV1[];
  history: CoopGameConceptSpecV1[];
  priorFailure?: CoopGameConceptSpecV1;
}): string {
  return `Create ONE fundamentally new PC/Steam friends co-op game concept to replace a HUMAN-REJECTED candidate. REJECT MEANS REPLACE, NOT REVISE. The rejected concept is negative-space evidence and must not be repaired, reskinned or cosmetically transformed.\n\nDISCOVERY OBJECTIVE:\n${JSON.stringify(input.objective, null, 2)}\n\nHUMAN-REJECTED CONCEPT — DO NOT REVIVE:\n${JSON.stringify(compactConcept(input.rejected), null, 2)}\n\nWHY THE HUMAN REJECTED IT:\n${input.feedback}\n\nALREADY HUMAN-APPROVED / PRESERVED CONCEPTS — STAY DIVERSE FROM THESE:\n${JSON.stringify(input.approved.map(compactConcept), null, 2)}\n\nRECENT CONCEPT HISTORY — NEGATIVE SPACE:\n${JSON.stringify(input.history.slice(0, 30).map(compactConcept), null, 2)}\n${input.priorFailure ? `\nPREVIOUS REPLACEMENT ATTEMPT WAS STILL TOO SIMILAR AND IS ALSO FORBIDDEN:\n${JSON.stringify(compactConcept(input.priorFailure), null, 2)}\n` : ""}\nHARD REPLACEMENT CONTRACT:\n- Change the fundamental core mechanic.\n- Change the type of co-op dependency.\n- Change what players physically/systemically do moment to moment.\n- Change the characteristic failure signature / source of tension.\n- Change the main social moment produced between friends.\n- A new setting, art style, characters, props, theme, camera or lore is NOT enough.\n- Do not combine the rejected mechanic with superficial additions.\n- The result must still satisfy the discovery objective and be visually testable in fake gameplay.\n- Use a fresh conceptId unrelated to the rejected conceptId.\n\n${schemaInstructions()}`;
}

const SYSTEM_PROMPT = `You are the Human Concept Gate designer inside an AI Co-op Game Discovery Factory. Human decisions are authoritative. For revise, faithfully improve the same concept. For reject, treat the old concept as forbidden negative space and invent a mechanically different game. Return typed design data, not prose commentary.`;

async function generateOne(input: {
  llm: HumanConceptGateLlm;
  model: string;
  prompt: string;
  signal?: AbortSignal;
  hashes: string[];
  usage: HumanConceptGateResult["usage"];
}): Promise<CoopGameConceptSpecV1> {
  const policy = getDiscoveryLlmPolicy("concept_exploration");
  const response = await input.llm.generate({
    model: input.model,
    system: SYSTEM_PROMPT,
    prompt: input.prompt,
    maxTokens: policy.maxOutputTokens,
    thinking: policy.thinking,
    signal: input.signal,
  });
  input.hashes.push(stableHash(response.text));
  addUsage(input.usage, response);
  return parseConcept(response.text);
}

export async function applyHumanConceptReviews(input: {
  llm: HumanConceptGateLlm;
  objective: DiscoveryObjectiveSpecV1;
  activeConcepts: CoopGameConceptSpecV1[];
  reviews: HumanConceptReviewState[];
  history: CoopGameConceptSpecV1[];
  model?: string;
  signal?: AbortSignal;
}): Promise<HumanConceptGateResult> {
  const reviewByConceptId = new Map(input.reviews.map((review) => [review.conceptId, review]));
  const approved = input.activeConcepts.filter(
    (concept) => reviewByConceptId.get(concept.conceptId)?.decision === "approve",
  );
  const nextConcepts: CoopGameConceptSpecV1[] = [...approved];
  const regeneratedConcepts: CoopGameConceptSpecV1[] = [];
  const occupied = new Set(input.history.map((concept) => concept.conceptId));
  input.activeConcepts.forEach((concept) => occupied.add(concept.conceptId));
  const model = input.model ?? "claude-sonnet-5";
  const rawResponseHashes: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let attempts = 0;

  for (const source of input.activeConcepts) {
    const review = reviewByConceptId.get(source.conceptId);
    if (!review || review.decision === "approve") continue;
    const feedback = review.rawFeedback?.trim() ?? "";
    if (!feedback) throw new Error(`HUMAN_CONCEPT_FEEDBACK_REQUIRED:${source.conceptId}`);

    if (review.decision === "revise") {
      attempts += 1;
      const candidate = await generateOne({
        llm: input.llm,
        model,
        prompt: revisionPrompt({ objective: input.objective, concept: source, feedback }),
        signal: input.signal,
        hashes: rawResponseHashes,
        usage,
      });
      const revised = withLineage({ candidate, source, review, attempt: attempts, occupied });
      occupied.add(revised.conceptId);
      regeneratedConcepts.push(revised);
      nextConcepts.push(revised);
      continue;
    }

    let acceptedReplacement: CoopGameConceptSpecV1 | null = null;
    let priorFailure: CoopGameConceptSpecV1 | undefined;
    for (let attempt = 1; attempt <= MAX_REGENERATION_ATTEMPTS; attempt += 1) {
      attempts += 1;
      const candidate = await generateOne({
        llm: input.llm,
        model,
        prompt: replacementPrompt({
          objective: input.objective,
          rejected: source,
          feedback,
          approved: [...approved, ...regeneratedConcepts],
          history: input.history,
          priorFailure,
        }),
        signal: input.signal,
        hashes: rawResponseHashes,
        usage,
      });
      const replacement = withLineage({ candidate, source, review, attempt, occupied });
      if (isMateriallyNewConcept(source, replacement)) {
        acceptedReplacement = replacement;
        break;
      }
      priorFailure = replacement;
    }

    if (!acceptedReplacement) {
      throw new Error(`HUMAN_CONCEPT_REPLACEMENT_TOO_SIMILAR:${source.conceptId}`);
    }
    occupied.add(acceptedReplacement.conceptId);
    regeneratedConcepts.push(acceptedReplacement);
    nextConcepts.push(acceptedReplacement);
  }

  const sourceOrder = new Map(input.activeConcepts.map((concept, index) => [concept.conceptId, index]));
  const ordered = nextConcepts.sort((left, right) => {
    const leftLineage = (left.metadata?.humanReviewLineage ?? {}) as Record<string, unknown>;
    const rightLineage = (right.metadata?.humanReviewLineage ?? {}) as Record<string, unknown>;
    const leftSource = typeof leftLineage.sourceConceptId === "string" ? leftLineage.sourceConceptId : left.conceptId;
    const rightSource = typeof rightLineage.sourceConceptId === "string" ? rightLineage.sourceConceptId : right.conceptId;
    return (sourceOrder.get(leftSource) ?? Number.MAX_SAFE_INTEGER) - (sourceOrder.get(rightSource) ?? Number.MAX_SAFE_INTEGER);
  });

  if (ordered.length !== input.activeConcepts.length) {
    throw new Error(
      `HUMAN_CONCEPT_GATE_CARDINALITY_MISMATCH:${ordered.length}:${input.activeConcepts.length}`,
    );
  }

  return {
    activeConcepts: ordered,
    regeneratedConcepts,
    model,
    rawResponseHashes,
    attempts,
    usage,
  };
}