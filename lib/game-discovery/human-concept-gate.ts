import { createHash } from "node:crypto";
import { z } from "zod";
import type { KieClaudeGenerateResult, KieClaudeTaskAdapter } from "../models/kie/claude-task";
import {
  conversationalGameConceptV2Schema,
  getConversationalGameConceptV2,
  projectConversationalConceptToLegacy,
  type ConversationalGameConceptV2,
} from "./conversational-concept";
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
const conversationalConceptEnvelopeSchema = z.object({ concept: conversationalGameConceptV2Schema }).strict();
const MAX_FRESH_CYCLE_ATTEMPTS = 3;

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

function parseConversationalConcept(text: string): ConversationalGameConceptV2 {
  const parsed = JSON.parse(extractJsonObject(text)) as unknown;
  const envelope = conversationalConceptEnvelopeSchema.safeParse(parsed);
  if (envelope.success) return envelope.data.concept;
  return conversationalGameConceptV2Schema.parse(parsed);
}

function addUsage(total: HumanConceptGateResult["usage"], response: KieClaudeGenerateResult): void {
  total.inputTokens += response.usage.inputTokens ?? 0;
  total.outputTokens += response.usage.outputTokens ?? 0;
  total.totalTokens += response.usage.totalTokens ?? 0;
}

function schemaInstructions(): string {
  return `Return ONLY JSON with this top-level shape: {"concept":{...}}. The concept MUST satisfy CoopGameConceptSpec v1 exactly:\n- schema: "coop_game_concept"; version: 1; conceptId: concise kebab-case string\n- oneSentencePitch, coreMechanic, coopDependency, failureMode, socialMoment, gameplayHook, spectacle, setting, artDirection, camera, readability: strings\n- playerRoles: 1..8 objects {role,responsibility,information?,power?}; optional information/power are strings\n- playerCount: {min,max,ideal}, all integers 2..4\n- interactionModel: non-empty string[]\n- noveltyAxes: at least 2 objects {axis,choice,whyDifferent}\n- buildability: {networking:"low"|"medium"|"high",physics:"low"|"medium"|"high",contentBurden:"low"|"medium"|"high",npcAiDependency:"none"|"light"|"heavy",systemicInteractions:"low"|"medium"|"high",mainRisks:string[],mvpRead:string}\n- referenceInfluences: array (or []) of {reference,borrowedPrinciple,mustNotCopy}\n- metadata: optional object.`;
}

function conversationalInstructions(): string {
  return `Return ONLY JSON with this small top-level shape:\n{"concept":{"schema":"conversational_game_concept","version":2,"conceptId":"fresh-stable-id","title":"human-facing title","contentMarkdown":"the complete human-readable concept"}}\nDo not recreate the old internal game-design questionnaire. contentMarkdown is the authoritative creative artifact: write it naturally for a human game designer, using only headings and detail that help explain the game.`;
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

function promptConcept(concept: CoopGameConceptSpecV1): Record<string, unknown> {
  const artifact = getConversationalGameConceptV2(concept);
  return artifact
    ? {
      conceptId: artifact.conceptId,
      title: artifact.title,
      contentMarkdown: artifact.contentMarkdown,
    }
    : compactConcept(concept);
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
 * Used only as a guard when every active concept was rejected and the factory must
 * start a fresh concept cycle. Ordinary Reject never calls this to create a replacement.
 */
export function isMateriallyNewConcept(
  rejected: CoopGameConceptSpecV1,
  replacement: CoopGameConceptSpecV1,
): boolean {
  const rejectedArtifact = getConversationalGameConceptV2(rejected);
  const replacementArtifact = getConversationalGameConceptV2(replacement);
  if (rejectedArtifact && replacementArtifact) {
    const before = `${rejectedArtifact.title}\n${rejectedArtifact.contentMarkdown}`;
    const after = `${replacementArtifact.title}\n${replacementArtifact.contentMarkdown}`;
    return jaccard(before, after) < 0.58;
  }

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
  action: "revise" | "new_cycle";
  feedback: string;
  attempt: number;
  occupied: Set<string>;
}): string {
  const suffix = stableHash(
    `${input.sourceId}:${input.action}:${input.feedback}:${input.attempt}:${input.candidateId}`,
  ).slice(0, 8);
  const baseRaw = input.action === "revise" ? input.sourceId : input.candidateId;
  const base = baseRaw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 140) || "concept";
  const marker = input.action === "revise" ? "rev" : "new";
  let next = `${base}-${marker}-${suffix}`.slice(0, 160);
  if (input.occupied.has(next) || next === input.sourceId) {
    next = `${base.slice(0, 130)}-${marker}-${suffix}-${input.attempt}`.slice(0, 160);
  }
  return next;
}

function sourceRefs(concept: CoopGameConceptSpecV1): string[] {
  const refs = concept.metadata?.v3SourceRefs;
  return Array.isArray(refs)
    ? refs.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
}

function withLineage(input: {
  candidate: CoopGameConceptSpecV1;
  source: CoopGameConceptSpecV1;
  review: HumanConceptReviewState;
  action: "revise" | "new_cycle";
  attempt: number;
  occupied: Set<string>;
}): CoopGameConceptSpecV1 {
  const feedback = input.review.rawFeedback?.trim() ?? "";
  const conceptId = lineageConceptId({
    candidateId: input.candidate.conceptId,
    sourceId: input.source.conceptId,
    action: input.action,
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
        action: input.action,
        sourceConceptId: input.source.conceptId,
        sourceConceptRunId: input.review.conceptRunId,
        sourceReviewId: input.review.reviewId ?? null,
        humanFeedback: feedback,
      },
    },
  });
}

function withConversationalLineage(input: {
  artifact: ConversationalGameConceptV2;
  objective: DiscoveryObjectiveSpecV1;
  source: CoopGameConceptSpecV1;
  review: HumanConceptReviewState;
  action: "revise" | "new_cycle";
  attempt: number;
  occupied: Set<string>;
  sourceRefs: string[];
}): CoopGameConceptSpecV1 {
  const feedback = input.review.rawFeedback?.trim() ?? "";
  const conceptId = lineageConceptId({
    candidateId: input.artifact.conceptId,
    sourceId: input.source.conceptId,
    action: input.action,
    feedback,
    attempt: input.attempt,
    occupied: input.occupied,
  });
  const artifact = conversationalGameConceptV2Schema.parse({
    ...input.artifact,
    conceptId,
  });
  const projected = projectConversationalConceptToLegacy({
    artifact,
    objective: input.objective,
    sourceRefs: [...new Set(input.sourceRefs)].slice(0, 8),
  });
  return coopGameConceptSpecV1Schema.parse({
    ...projected,
    metadata: {
      ...(projected.metadata ?? {}),
      humanReviewLineage: {
        action: input.action,
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

function conversationalRevisionPrompt(input: {
  objective: DiscoveryObjectiveSpecV1;
  concept: CoopGameConceptSpecV1;
  feedback: string;
}): string {
  const artifact = getConversationalGameConceptV2(input.concept);
  if (!artifact) throw new Error(`V3_CONVERSATIONAL_ARTIFACT_MISSING:${input.concept.conceptId}`);
  return `Revise ONE existing PC/Steam friends co-op game concept according to authoritative human feedback. This is a revision of the same recognizable game, not a replacement and not an internal form-filling task.\n\nDISCOVERY OBJECTIVE:\n${JSON.stringify(input.objective, null, 2)}\n\nCURRENT HUMAN CONCEPT — AUTHORITATIVE CREATIVE ARTIFACT:\n${JSON.stringify({ title: artifact.title, contentMarkdown: artifact.contentMarkdown }, null, 2)}\n\nHUMAN FEEDBACK — AUTHORITATIVE:\n${input.feedback}\n\nWrite the complete revised concept as natural, coherent human-facing game design. Preserve strong uncriticized decisions and change what the human actually requested. If the original concept is Russian, keep the revised title and content in Russian. Do not expose legacy buildability/networking enums or reconstruct the old schema.\n\n${conversationalInstructions()}`;
}

function freshCyclePrompt(input: {
  objective: DiscoveryObjectiveSpecV1;
  rejected: Array<{ concept: CoopGameConceptSpecV1; review: HumanConceptReviewState }>;
  history: CoopGameConceptSpecV1[];
  alreadyGenerated: CoopGameConceptSpecV1[];
  priorFailure?: CoopGameConceptSpecV1;
}): string {
  return `Create ONE concept for a completely NEW discovery cycle because the human rejected EVERY active concept. This is not a one-for-one replacement and you must not repair or reskin any rejected idea. Generate a fresh PC/Steam friends co-op game hypothesis that still satisfies the original discovery objective.\n\nDISCOVERY OBJECTIVE:\n${JSON.stringify(input.objective, null, 2)}\n\nALL REJECTED CONCEPTS AND HUMAN REASONS — USE ONLY AS NEGATIVE SPACE:\n${JSON.stringify(input.rejected.map(({ concept, review }) => ({ concept: compactConcept(concept), feedback: review.rawFeedback ?? "" })), null, 2)}\n\nOTHER RECENT HISTORY — ALSO AVOID COSMETIC REPEATS:\n${JSON.stringify(input.history.slice(0, 30).map(compactConcept), null, 2)}\n\nALREADY GENERATED IN THIS FRESH CYCLE — STAY DIVERSE FROM THESE:\n${JSON.stringify(input.alreadyGenerated.map(compactConcept), null, 2)}\n${input.priorFailure ? `\nPREVIOUS ATTEMPT WAS TOO CLOSE TO REJECTED SPACE:\n${JSON.stringify(compactConcept(input.priorFailure), null, 2)}\n` : ""}\nRules:\n- Invent a new fundamental core mechanic and co-op dependency, not a theme swap.\n- Change what players do moment to moment and how failure/social tension is produced.\n- Keep the idea visually readable in a short fake-gameplay experiment and buildable as a small PC prototype.\n- Do not copy rejected concepts, recent history, characters, branding or level layouts.\n- Use a fresh conceptId.\n\n${schemaInstructions()}`;
}

function conversationalFreshCyclePrompt(input: {
  objective: DiscoveryObjectiveSpecV1;
  rejected: Array<{ concept: CoopGameConceptSpecV1; review: HumanConceptReviewState }>;
  history: CoopGameConceptSpecV1[];
  alreadyGenerated: CoopGameConceptSpecV1[];
  priorFailure?: CoopGameConceptSpecV1;
}): string {
  return `Create ONE concept for a completely NEW discovery cycle because the human rejected EVERY active concept. Do not repair, reskin or mechanically paraphrase a rejected idea. Think like a strong human game designer, then describe one coherent new game naturally.\n\nDISCOVERY OBJECTIVE:\n${JSON.stringify(input.objective, null, 2)}\n\nALL REJECTED HUMAN CONCEPTS AND REASONS — NEGATIVE SPACE ONLY:\n${JSON.stringify(input.rejected.map(({ concept, review }) => ({ concept: promptConcept(concept), feedback: review.rawFeedback ?? "" })), null, 2)}\n\nRECENT HISTORY — AVOID COSMETIC REPEATS:\n${JSON.stringify(input.history.slice(0, 30).map(promptConcept), null, 2)}\n\nALREADY GENERATED IN THIS FRESH CYCLE — STAY MEANINGFULLY DIFFERENT:\n${JSON.stringify(input.alreadyGenerated.map(promptConcept), null, 2)}\n${input.priorFailure ? `\nPREVIOUS ATTEMPT WAS TOO CLOSE TO REJECTED SPACE:\n${JSON.stringify(promptConcept(input.priorFailure), null, 2)}\n` : ""}\nThe new game's moment-to-moment actions, dependency between friends, characteristic failures and social dynamics must genuinely move into new design space. Keep it plausible to prototype and readable in later short gameplay visualization, but do not turn the response into a checklist. If the discovery objective is Russian, write the title and content in Russian.\n\n${conversationalInstructions()}`;
}

const SYSTEM_PROMPT = `You are the Human Concept Gate designer inside an AI Co-op Game Discovery Factory. Human decisions are authoritative. Revise means improve the same idea. Reject normally means drop the idea with no replacement. Only when the workflow explicitly says every active concept was rejected may you generate a fresh discovery cycle. Return typed design data, not prose commentary.`;

const CONVERSATIONAL_SYSTEM_PROMPT = `You are the Human Concept Gate designer inside an AI Co-op Game Discovery Factory. Human decisions are authoritative. Think and write like ChatGPT collaborating with a human game designer. Preserve or change the game according to the human decision, and return the rich human-facing concept inside only the tiny requested JSON envelope.`;

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

async function generateConversationalOne(input: {
  llm: HumanConceptGateLlm;
  model: string;
  prompt: string;
  signal?: AbortSignal;
  hashes: string[];
  usage: HumanConceptGateResult["usage"];
}): Promise<ConversationalGameConceptV2> {
  const policy = getDiscoveryLlmPolicy("concept_exploration");
  const response = await input.llm.generate({
    model: input.model,
    system: CONVERSATIONAL_SYSTEM_PROMPT,
    prompt: input.prompt,
    maxTokens: policy.maxOutputTokens,
    thinking: policy.thinking,
    signal: input.signal,
  });
  input.hashes.push(stableHash(response.text));
  addUsage(input.usage, response);
  return parseConversationalConcept(response.text);
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
  const model = input.model ?? "claude-sonnet-5";
  const rawResponseHashes: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const regeneratedConcepts: CoopGameConceptSpecV1[] = [];
  const occupied = new Set(input.history.map((concept) => concept.conceptId));
  input.activeConcepts.forEach((concept) => occupied.add(concept.conceptId));
  let attempts = 0;

  const allRejected = input.activeConcepts.length > 0 && input.activeConcepts.every(
    (concept) => reviewByConceptId.get(concept.conceptId)?.decision === "reject",
  );

  if (allRejected) {
    const rejected = input.activeConcepts.map((concept) => {
      const review = reviewByConceptId.get(concept.conceptId);
      if (!review || review.decision !== "reject") {
        throw new Error(`HUMAN_CONCEPT_REVIEW_MISSING:${concept.conceptId}`);
      }
      if (!review.rawFeedback?.trim()) {
        throw new Error(`HUMAN_CONCEPT_FEEDBACK_REQUIRED:${concept.conceptId}`);
      }
      return { concept, review };
    });
    const conversationalCycle = rejected.every(({ concept }) => Boolean(getConversationalGameConceptV2(concept)));
    const cycleRefs = [...new Set(rejected.flatMap(({ concept }) => sourceRefs(concept)))];

    for (let index = 0; index < rejected.length; index += 1) {
      const source = rejected[index]!;
      let accepted: CoopGameConceptSpecV1 | null = null;
      let priorFailure: CoopGameConceptSpecV1 | undefined;

      for (let attempt = 1; attempt <= MAX_FRESH_CYCLE_ATTEMPTS; attempt += 1) {
        attempts += 1;
        let fresh: CoopGameConceptSpecV1;
        if (conversationalCycle) {
          const artifact = await generateConversationalOne({
            llm: input.llm,
            model,
            prompt: conversationalFreshCyclePrompt({
              objective: input.objective,
              rejected,
              history: input.history,
              alreadyGenerated: regeneratedConcepts,
              priorFailure,
            }),
            signal: input.signal,
            hashes: rawResponseHashes,
            usage,
          });
          fresh = withConversationalLineage({
            artifact,
            objective: input.objective,
            source: source.concept,
            review: source.review,
            action: "new_cycle",
            attempt,
            occupied,
            sourceRefs: cycleRefs.length ? cycleRefs : sourceRefs(source.concept),
          });
        } else {
          const candidate = await generateOne({
            llm: input.llm,
            model,
            prompt: freshCyclePrompt({
              objective: input.objective,
              rejected,
              history: input.history,
              alreadyGenerated: regeneratedConcepts,
              priorFailure,
            }),
            signal: input.signal,
            hashes: rawResponseHashes,
            usage,
          });
          fresh = withLineage({
            candidate,
            source: source.concept,
            review: source.review,
            action: "new_cycle",
            attempt,
            occupied,
          });
        }
        if (isMateriallyNewConcept(source.concept, fresh)) {
          accepted = fresh;
          break;
        }
        priorFailure = fresh;
      }

      if (!accepted) {
        throw new Error(`HUMAN_CONCEPT_FRESH_CYCLE_TOO_SIMILAR:${source.concept.conceptId}`);
      }
      occupied.add(accepted.conceptId);
      regeneratedConcepts.push(accepted);
    }

    return {
      activeConcepts: regeneratedConcepts,
      regeneratedConcepts,
      model,
      rawResponseHashes,
      attempts,
      usage,
    };
  }

  const nextConcepts: CoopGameConceptSpecV1[] = [];
  for (const source of input.activeConcepts) {
    const review = reviewByConceptId.get(source.conceptId);
    if (!review) throw new Error(`HUMAN_CONCEPT_REVIEW_MISSING:${source.conceptId}`);

    if (review.decision === "approve") {
      nextConcepts.push(source);
      continue;
    }

    if (review.decision === "reject") {
      // Reject is intentionally terminal for this card. No paid replacement call is made.
      continue;
    }

    const feedback = review.rawFeedback?.trim() ?? "";
    if (!feedback) throw new Error(`HUMAN_CONCEPT_FEEDBACK_REQUIRED:${source.conceptId}`);
    attempts += 1;

    let revised: CoopGameConceptSpecV1;
    if (getConversationalGameConceptV2(source)) {
      const artifact = await generateConversationalOne({
        llm: input.llm,
        model,
        prompt: conversationalRevisionPrompt({ objective: input.objective, concept: source, feedback }),
        signal: input.signal,
        hashes: rawResponseHashes,
        usage,
      });
      revised = withConversationalLineage({
        artifact,
        objective: input.objective,
        source,
        review,
        action: "revise",
        attempt: attempts,
        occupied,
        sourceRefs: sourceRefs(source),
      });
    } else {
      const candidate = await generateOne({
        llm: input.llm,
        model,
        prompt: revisionPrompt({ objective: input.objective, concept: source, feedback }),
        signal: input.signal,
        hashes: rawResponseHashes,
        usage,
      });
      revised = withLineage({
        candidate,
        source,
        review,
        action: "revise",
        attempt: attempts,
        occupied,
      });
    }
    occupied.add(revised.conceptId);
    regeneratedConcepts.push(revised);
    nextConcepts.push(revised);
  }

  if (!nextConcepts.length) {
    throw new Error("HUMAN_CONCEPT_GATE_EMPTY_WITHOUT_ALL_REJECTED");
  }

  return {
    activeConcepts: nextConcepts,
    regeneratedConcepts,
    model,
    rawResponseHashes,
    attempts,
    usage,
  };
}
