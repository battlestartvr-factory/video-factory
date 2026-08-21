import { createHash } from "node:crypto";
import { z } from "zod";
import type { KieClaudeGenerateResult, KieClaudeTaskAdapter } from "../models/kie/claude-task";
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

export function gameplayDurationSeconds(objective: DiscoveryObjectiveSpecV1): number {
  const configured = Number(objective.metadata?.gameplayDurationSec ?? 5);
  if (!Number.isFinite(configured)) return 5;
  return Math.min(15, Math.max(3, Math.round(configured)));
}

function schemaInstructions(durationSec: number): string {
  return `Return ONLY JSON {"moments":[...]}. Each moment must satisfy GameplayMomentSpec v1 exactly:\n- schema:"gameplay_moment", version:1, momentId, conceptId, hypothesis\n- durationTargetSec:${durationSec}\n- setup\n- playerActions: at least 2 [{role,action,dependencyOnOthers}]\n- coopDependencyEvidence, socialTension\n- successBeat and/or failureBeat (at least one)\n- expectedViewerUnderstanding, cameraIntent\n- requiredVisualEvidence: non-empty string[]\n- optional metadata object.\nUse momentId as a concise stable ID derived from conceptId.`;
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
  const plannerPrompt = `Choose exactly one ${durationSec}-second fake-gameplay moment for each selected concept. The purpose is to test the game mechanic, not make a trailer.\n\nDISCOVERY OBJECTIVE:\n${JSON.stringify(input.objective, null, 2)}\n\nSELECTED CONCEPTS:\n${JSON.stringify(input.concepts, null, 2)}\n\nFor each concept, the moment must visibly prove:\n- why the other player is mechanically necessary;\n- what each player is doing at the same time;\n- one social reaction such as coordination, blame, rescue, panic, trust, sacrifice, or synchronized success;\n- a legible success/failure consequence;\n- a camera/framing choice that makes the mechanic understandable without narration.\nKeep the scenario narrow enough for one ${durationSec}s production gameplay shot. Do not change the concept to make it easier to visualize.\n\n${schemaInstructions(durationSec)}`;

  const first = await input.llm.generate({
    model,
    system:
      "You are the Gameplay Moment Planner inside an AI Co-op Game Discovery Factory. Turn a game hypothesis into one falsifiable, visually legible co-op gameplay moment. Mechanics and evidence come before spectacle.",
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
      system: "Repair JSON/schema only. Preserve the planned gameplay moments. Return JSON only.",
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