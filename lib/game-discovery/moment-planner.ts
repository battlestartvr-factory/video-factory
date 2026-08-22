import { createHash } from "node:crypto";
import { z } from "zod";
import type { KieClaudeGenerateResult, KieClaudeTaskAdapter } from "../models/kie/claude-task";
import { getConversationalGameConceptV2 } from "./conversational-concept";
import { getDiscoveryLlmPolicy } from "./model-policy";
import {
  gameplayMomentSpecV1Schema,
  type CoopGameConceptSpecV1,
  type DiscoveryObjectiveSpecV1,
  type GameplayMomentSpecV1,
} from "./schemas";

const momentBatchSchema = z
  .object({ moments: z.array(gameplayMomentSpecV1Schema).min(1).max(4) })
  .strict();

export interface GameplayMomentPlannerLlm {
  generate: KieClaudeTaskAdapter["generate"];
}

export interface GameplayMomentPlanningResult {
  moments: GameplayMomentSpecV1[];
  model: string;
  rawResponseHashes: string[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim() ?? trimmed;
  try {
    JSON.parse(fenced);
    return fenced;
  } catch {
    const start = fenced.indexOf("{");
    const end = fenced.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("GAMEPLAY_MOMENT_JSON_NOT_FOUND");
    return fenced.slice(start, end + 1);
  }
}

function parse(text: string): GameplayMomentSpecV1[] {
  return momentBatchSchema.parse(JSON.parse(extractJson(text)) as unknown).moments;
}

function addUsage(
  total: GameplayMomentPlanningResult["usage"],
  response: KieClaudeGenerateResult,
): void {
  total.inputTokens += response.usage.inputTokens ?? 0;
  total.outputTokens += response.usage.outputTokens ?? 0;
  total.totalTokens += response.usage.totalTokens ?? 0;
}

// Hailuo 03 accepts 4-15s, while Kling 3 remains our fallback and accepts 5/10/15s.
// Keep a shared factory duration bucket so one planned gameplay moment can move between
// the primary H3 route and the Kling fallback without changing its experiment semantics.
export const GAMEPLAY_VIDEO_DURATIONS = [5, 10, 15] as const;
export const KLING_GAMEPLAY_DURATIONS = GAMEPLAY_VIDEO_DURATIONS;
export type GameplayVideoDuration = (typeof GAMEPLAY_VIDEO_DURATIONS)[number];
export type KlingGameplayDuration = GameplayVideoDuration;

export function gameplayDurationSeconds(objective: DiscoveryObjectiveSpecV1): GameplayVideoDuration {
  const configured = Number(objective.metadata?.gameplayDurationSec ?? 10);
  if (!Number.isFinite(configured)) return 10;
  return GAMEPLAY_VIDEO_DURATIONS.reduce((best, candidate) =>
    Math.abs(candidate - configured) < Math.abs(best - configured) ? candidate : best,
  );
}

function schemaInstructions(durationSec: number): string {
  return `Return ONLY JSON {"moments":[...]}. Each moment must satisfy GameplayMomentSpec v1 exactly:\n- schema:"gameplay_moment", version:1, momentId, conceptId, hypothesis\n- durationTargetSec:${durationSec}\n- setup\n- playerActions: at least 2 [{role,action,dependencyOnOthers}]\n- coopDependencyEvidence, socialTension\n- successBeat and/or failureBeat (at least one)\n- expectedViewerUnderstanding, cameraIntent\n- requiredVisualEvidence: non-empty string[]\n- metadata object with humanFacingSummaryRu: one short natural Russian UI sentence describing the visible player action and immediate world response. This field is UI-only; do not replace or translate canonical planning fields with it.\nUse momentId as a concise stable ID derived from conceptId.`;
}

function conceptForPlanner(concept: CoopGameConceptSpecV1): unknown {
  const artifact = getConversationalGameConceptV2(concept);
  if (!artifact) return concept;
  const metadata = concept.metadata ?? {};
  return {
    conceptId: artifact.conceptId,
    title: artifact.title,
    approvedConceptText: artifact.contentMarkdown,
    sourceRefs: Array.isArray(metadata.v3SourceRefs) ? metadata.v3SourceRefs : [],
    note: "This complete human-approved text is authoritative. Do not infer creative meaning from legacy compatibility fields.",
  };
}

export async function planGameplayMoments(input: {
  llm: GameplayMomentPlannerLlm;
  objective: DiscoveryObjectiveSpecV1;
  concepts: CoopGameConceptSpecV1[];
  model?: string;
  signal?: AbortSignal;
}): Promise<GameplayMomentPlanningResult> {
  if (!input.concepts.length) throw new Error("GAMEPLAY_MOMENT_EMPTY_BATCH");
  if (input.concepts.length > 4) throw new Error("GAMEPLAY_MOMENT_BATCH_TOO_LARGE");

  const policy = getDiscoveryLlmPolicy("gameplay_moment_planning");
  const repairPolicy = getDiscoveryLlmPolicy("schema_repair");
  const model = input.model ?? policy.primaryModel;
  const durationSec = gameplayDurationSeconds(input.objective);
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const hashes: string[] = [];
  const conceptIds = input.concepts.map((concept) => concept.conceptId);
  const plannerPrompt = `Choose exactly one ${durationSec}-second fake-gameplay moment for each selected concept. The purpose is to test the game mechanic, not make a trailer.\n\nDISCOVERY OBJECTIVE:\n${JSON.stringify(input.objective, null, 2)}\n\nSELECTED CONCEPTS — FULL HUMAN-APPROVED TEXT IS AUTHORITATIVE:\n${JSON.stringify(input.concepts.map(conceptForPlanner), null, 2)}\n\nFor each concept, the moment must visibly prove:\n- why the other player is mechanically necessary;\n- what each player is doing at the same time;\n- one social reaction such as coordination, blame, rescue, panic, trust, sacrifice, or synchronized success;\n- a legible success/failure consequence;\n- a camera/framing choice that is the real player-visible gameplay camera for this concept and makes the mechanic understandable without narration. First-person, over-the-shoulder/follow, side-view, top-down, or isometric framing is allowed only when it is genuinely the normal camera a player would see while controlling the game;\n- any camera motion must come from player look/aim/movement or normal in-game follow behavior, never from a filmmaker or spectator.\nNever use broadcast, spectator, drone, cinematic, orbit, dolly, crane, hero-shot, detached tracking, trailer/marketing, cutaway, montage, dramatic reframe, or dramatic zoom camera language. Ask: “What would the player actually see on-screen during this ${durationSec}-second gameplay interaction?”\nKeep the scenario narrow enough for one ${durationSec}s production gameplay shot. Do not change the concept to make it easier to visualize. For v3 conversational concepts, read the complete approvedConceptText like a strong model would read a normal ChatGPT answer; do not rely on internal compatibility fields.\n\n${schemaInstructions(durationSec)}`;

  const first = await input.llm.generate({
    model,
    system:
      "You are the Gameplay Moment Planner inside an AI Co-op Game Discovery Factory. Turn a game hypothesis into one falsifiable, visually legible co-op gameplay moment. Mechanics and evidence come before spectacle. CAMERA AUTHENTICITY IS A HARD CONSTRAINT: cameraIntent must describe only the player-visible, control-bound camera that would exist during normal gameplay. Never invent a broadcast, spectator, cinematic, drone, detached tracking, trailer, or filmmaker camera to make the idea look better.",
    prompt: plannerPrompt,
    maxTokens: policy.maxOutputTokens,
    thinking: policy.thinking,
    signal: input.signal,
  });
  hashes.push(hash(first.text));
  addUsage(usage, first);

  let moments: GameplayMomentSpecV1[];
  try {
    moments = parse(first.text);
  } catch (firstError) {
    const repair = await input.llm.generate({
      model: repairPolicy.primaryModel,
      system: "Repair JSON/schema only. Preserve the planned gameplay moments. cameraIntent must still satisfy the player-visible gameplay-camera constraints in the supplied schema instructions. Return JSON only.",
      prompt: `Repair this response into exactly one valid GameplayMomentSpec v1 for each concept ID ${JSON.stringify(conceptIds)} and set durationTargetSec=${durationSec}.\n\nINVALID RESPONSE:\n${first.text}\n\n${schemaInstructions(durationSec)}`,
      maxTokens: repairPolicy.maxOutputTokens,
      thinking: repairPolicy.thinking,
      signal: input.signal,
    });
    hashes.push(hash(repair.text));
    addUsage(usage, repair);
    try {
      moments = parse(repair.text);
    } catch (repairError) {
      throw new Error(
        `GAMEPLAY_MOMENT_SCHEMA_INVALID: ${repairError instanceof Error ? repairError.message : String(repairError)}; first=${firstError instanceof Error ? firstError.message : String(firstError)}`,
      );
    }
  }

  const expectedIds = new Set(conceptIds);
  const byConcept = new Map<string, GameplayMomentSpecV1>();
  for (const rawMoment of moments) {
    const moment = rawMoment.durationTargetSec === durationSec
      ? rawMoment
      : gameplayMomentSpecV1Schema.parse({ ...rawMoment, durationTargetSec: durationSec });
    if (!expectedIds.has(moment.conceptId)) throw new Error(`GAMEPLAY_MOMENT_UNKNOWN_CONCEPT:${moment.conceptId}`);
    if (byConcept.has(moment.conceptId)) throw new Error(`GAMEPLAY_MOMENT_DUPLICATE_CONCEPT:${moment.conceptId}`);
    byConcept.set(moment.conceptId, moment);
  }
  if (byConcept.size !== expectedIds.size) {
    throw new Error(`GAMEPLAY_MOMENT_COUNT_MISMATCH:${byConcept.size}/${expectedIds.size}`);
  }

  return {
    moments: input.concepts.map((concept) => byConcept.get(concept.conceptId)!),
    model,
    rawResponseHashes: hashes,
    usage,
  };
}
