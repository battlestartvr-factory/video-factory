import { createHash } from "node:crypto";
import { z } from "zod";
import type { KieClaudeGenerateResult, KieClaudeTaskAdapter } from "../models/kie/claude-task";
import { getDiscoveryLlmPolicy } from "./model-policy";
import {
  shotSpecV1Schema,
  type CoopGameConceptSpecV1,
  type DiscoveryObjectiveSpecV1,
  type GameplayMomentSpecV1,
  type ShotSpecV1,
} from "./schemas";

const shotBatchSchema = z.object({ shots: z.array(shotSpecV1Schema).min(1).max(4) }).strict();

export interface ShotPlannerLlm {
  generate: KieClaudeTaskAdapter["generate"];
}

export interface DiscoveryFeedbackMemory {
  mustShow: string[];
  mustAvoid: string[];
  errorTags: string[];
}

export interface ShotPlanningResult {
  shots: ShotSpecV1[];
  model: string;
  repairModel: string;
  escalated: boolean;
  rawResponseHashes: string[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function addUsage(total: ShotPlanningResult["usage"], response: KieClaudeGenerateResult): void {
  total.inputTokens += response.usage.inputTokens ?? 0;
  total.outputTokens += response.usage.outputTokens ?? 0;
  total.totalTokens += response.usage.totalTokens ?? 0;
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
    if (start < 0 || end <= start) throw new Error("SHOT_PLANNER_JSON_NOT_FOUND");
    return fenced.slice(start, end + 1);
  }
}

function parse(text: string): ShotSpecV1[] {
  return shotBatchSchema.parse(JSON.parse(extractJson(text)) as unknown).shots;
}

function schemaInstructions(): string {
  return `Return ONLY JSON {"shots":[...]}. Each shot must satisfy Gameplay Shot v1 exactly:\n- schema:"gameplay_shot", version:1, shotId, momentId, order:0\n- durationSec:5\n- purpose:"mechanic"|"failure"|"payoff" (prefer mechanic/failure for first evidence)\n- actors:string[] with all mechanically relevant player roles visible\n- action, camera, environment\n- continuity:{preserve:[]}\n- expectedEvidence:string[]\n- generationPlan:{keyframeRequired:true,imageModel:"nano-banana-2",videoModel:"kling-3",videoMode:"image-to-video",aspectRatio:"9:16",durationSec:5}\n- optional metadata object.\nFor each moment, copy EVERY string from moment.requiredVisualEvidence verbatim into shot.expectedEvidence. Produce exactly one shot per moment.`;
}

function prompt(input: {
  objective: DiscoveryObjectiveSpecV1;
  concepts: CoopGameConceptSpecV1[];
  moments: GameplayMomentSpecV1[];
  feedback: DiscoveryFeedbackMemory;
}): string {
  return `Plan one five-second fake-gameplay evidence shot for each selected gameplay moment. This is not a trailer shot. It is a cheap reference-image/video anchor whose only job is to make the co-op mechanic understandable.\n\nDISCOVERY OBJECTIVE:\n${JSON.stringify(input.objective, null, 2)}\n\nSELECTED CONCEPTS:\n${JSON.stringify(input.concepts, null, 2)}\n\nGAMEPLAY MOMENTS:\n${JSON.stringify(input.moments, null, 2)}\n\nPERSISTED HUMAN FEEDBACK MEMORY:\n${JSON.stringify(input.feedback, null, 2)}\n\nRules:\n- show all player roles whose simultaneous actions prove the dependency;\n- prioritize readable gameplay framing over cinematic composition;\n- the visible consequence must fit inside one 5s shot;\n- preserve the game concept; do not invent a prettier replacement mechanic;\n- obey mustShow and mustAvoid feedback; explicit previous error tags are warnings against repeating rejected patterns;\n- expectedEvidence must include every requiredVisualEvidence item verbatim so coverage is mechanically auditable.\n\n${schemaInstructions()}`;
}

function validateCoverage(
  shots: ShotSpecV1[],
  moments: GameplayMomentSpecV1[],
): string[] {
  const issues: string[] = [];
  const byMoment = new Map(shots.map((shot) => [shot.momentId, shot]));

  for (const moment of moments) {
    const shot = byMoment.get(moment.momentId);
    if (!shot) {
      issues.push(`missing_shot:${moment.momentId}`);
      continue;
    }
    for (const evidence of moment.requiredVisualEvidence) {
      if (!shot.expectedEvidence.includes(evidence)) {
        issues.push(`missing_required_evidence:${moment.momentId}:${evidence}`);
      }
    }
    const roleNames = moment.playerActions.map((action) => action.role.toLowerCase());
    const visible = shot.actors.map((actor) => actor.toLowerCase()).join(" ");
    for (const role of roleNames) {
      if (!visible.includes(role)) issues.push(`missing_actor_role:${moment.momentId}:${role}`);
    }
    if (
      shot.durationSec !== 5 ||
      shot.generationPlan.durationSec !== 5 ||
      shot.generationPlan.keyframeRequired !== true ||
      shot.generationPlan.imageModel !== "nano-banana-2" ||
      shot.generationPlan.videoModel !== "kling-3" ||
      shot.generationPlan.videoMode !== "image-to-video" ||
      shot.generationPlan.aspectRatio !== "9:16"
    ) {
      issues.push(`invalid_smoke_generation_plan:${moment.momentId}`);
    }
  }

  if (byMoment.size !== moments.length) issues.push(`shot_count_mismatch:${byMoment.size}/${moments.length}`);
  return issues;
}

async function generateAndParse(input: {
  llm: ShotPlannerLlm;
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
  thinking: boolean;
  signal?: AbortSignal;
  hashes: string[];
  usage: ShotPlanningResult["usage"];
  repairModel: string;
}): Promise<ShotSpecV1[]> {
  const response = await input.llm.generate({
    model: input.model,
    system: input.system,
    prompt: input.prompt,
    maxTokens: input.maxTokens,
    thinking: input.thinking,
    signal: input.signal,
  });
  input.hashes.push(hash(response.text));
  addUsage(input.usage, response);

  try {
    return parse(response.text);
  } catch (firstError) {
    const repairPolicy = getDiscoveryLlmPolicy("schema_repair");
    const repair = await input.llm.generate({
      model: input.repairModel,
      system: "Repair JSON/schema only. Preserve the shot plan semantics. Return JSON only.",
      prompt: `Repair the following shot response into valid ShotSpec v1 objects. Do not redesign the shots.\n\nINVALID RESPONSE:\n${response.text}\n\n${schemaInstructions()}`,
      maxTokens: repairPolicy.maxOutputTokens,
      thinking: false,
      signal: input.signal,
    });
    input.hashes.push(hash(repair.text));
    addUsage(input.usage, repair);
    try {
      return parse(repair.text);
    } catch (repairError) {
      throw new Error(
        `SHOT_PLANNER_SCHEMA_INVALID: ${repairError instanceof Error ? repairError.message : String(repairError)}; first=${firstError instanceof Error ? firstError.message : String(firstError)}`,
      );
    }
  }
}

export async function planGameplayShots(input: {
  llm: ShotPlannerLlm;
  objective: DiscoveryObjectiveSpecV1;
  concepts: CoopGameConceptSpecV1[];
  moments: GameplayMomentSpecV1[];
  feedbackMemory?: DiscoveryFeedbackMemory;
  signal?: AbortSignal;
}): Promise<ShotPlanningResult> {
  if (!input.moments.length) throw new Error("SHOT_PLANNER_EMPTY_BATCH");
  if (input.moments.length > 4) throw new Error("SHOT_PLANNER_BATCH_TOO_LARGE");

  const policy = getDiscoveryLlmPolicy("shot_planning");
  const repairPolicy = getDiscoveryLlmPolicy("schema_repair");
  const feedback = input.feedbackMemory ?? { mustShow: [], mustAvoid: [], errorTags: [] };
  const hashes: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const system =
    "You are the economical Shot Planner inside an AI Co-op Game Discovery Factory. Plan readable gameplay evidence, not cinematic advertising. The first reference still must expose the mechanic clearly enough for a human to approve or reject before video generation.";
  const basePrompt = prompt({ ...input, feedback });

  let shots = await generateAndParse({
    llm: input.llm,
    model: policy.primaryModel,
    system,
    prompt: basePrompt,
    maxTokens: policy.maxOutputTokens,
    thinking: policy.thinking,
    signal: input.signal,
    hashes,
    usage,
    repairModel: repairPolicy.primaryModel,
  });

  let issues = validateCoverage(shots, input.moments);
  let escalated = false;
  if (issues.length && policy.automaticEscalation && policy.fallbackModels.length) {
    escalated = true;
    const fallbackModel = policy.fallbackModels[0]!;
    shots = await generateAndParse({
      llm: input.llm,
      model: fallbackModel,
      system,
      prompt: `${basePrompt}\n\nThe cheap draft failed deterministic evidence checks. Fix these exact issues, not the concept:\n${JSON.stringify(issues, null, 2)}`,
      maxTokens: policy.maxOutputTokens,
      thinking: true,
      signal: input.signal,
      hashes,
      usage,
      repairModel: repairPolicy.primaryModel,
    });
    issues = validateCoverage(shots, input.moments);
  }

  if (issues.length) throw new Error(`SHOT_PLANNER_EVIDENCE_INVALID:${issues.join("|")}`);

  const byMoment = new Map(shots.map((shot) => [shot.momentId, shot]));
  return {
    shots: input.moments.map((moment) => byMoment.get(moment.momentId)!),
    model: escalated ? policy.fallbackModels[0]! : policy.primaryModel,
    repairModel: repairPolicy.primaryModel,
    escalated,
    rawResponseHashes: hashes,
    usage,
  };
}
