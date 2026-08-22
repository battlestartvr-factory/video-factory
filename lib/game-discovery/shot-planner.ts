import { createHash } from "node:crypto";
import { z } from "zod";
import type { KieClaudeGenerateResult, KieClaudeTaskAdapter } from "../models/kie/claude-task";
import {
  attachGameplayAuthenticitySpec,
  gameplayAuthenticitySpecFromShot,
} from "./gameplay-authenticity";
import { gameplayDurationSeconds } from "./moment-planner";
import { getDiscoveryLlmPolicy } from "./model-policy";
import {
  shotSpecV1Schema,
  type CoopGameConceptSpecV1,
  type DiscoveryObjectiveSpecV1,
  type GameplayMomentSpecV1,
  type ShotSpecV1,
} from "./schemas";

const shotBatchSchema = z.object({ shots: z.array(shotSpecV1Schema).min(1).max(4) }).strict();

export const PRIMARY_GAMEPLAY_VIDEO_MODEL = "minimax-h3" as const;

type DiscoveryImageModel = NonNullable<ShotSpecV1["generationPlan"]["imageModel"]>;

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
  const shots = shotBatchSchema.parse(JSON.parse(extractJson(text)) as unknown).shots;
  return shots.map((shot) => attachGameplayAuthenticitySpec(shot));
}

export function preferredDiscoveryImageModel(objective: DiscoveryObjectiveSpecV1): DiscoveryImageModel {
  const configured = objective.metadata?.preferredImageModel;
  if (configured === "nano-banana-2" || configured === "nano-banana-pro" || configured === "gpt-image-2") {
    return configured;
  }
  return "gpt-image-2";
}

function normalizeGenerationPolicy(
  shot: ShotSpecV1,
  durationSec: number,
  imageModel: DiscoveryImageModel,
): ShotSpecV1 {
  // Provider routing is factory policy, not a creative decision. The LLM may describe the
  // shot, but it cannot silently choose an older video provider or stale duration. This also
  // avoids paying for a stronger repair pass when the creative shot is valid and only the
  // provider-policy fields drifted.
  return shotSpecV1Schema.parse({
    ...shot,
    durationSec,
    generationPlan: {
      ...shot.generationPlan,
      keyframeRequired: true,
      imageModel,
      videoModel: PRIMARY_GAMEPLAY_VIDEO_MODEL,
      videoMode: "image-to-video",
      aspectRatio: "16:9",
      durationSec,
    },
  });
}

function authenticityInstructions(): string {
  return `Every shot.metadata MUST contain gameplayAuthenticityPlan with this exact typed evidence contract:\n{
  "schema":"gameplay_authenticity_plan","version":1,"shotId":"<same shotId>","momentId":"<same momentId>",
  "controllablePlayer":{"role":"...","obvious":true,"viewpointPlausiblyPlayable":true,"scriptedCharactersOnly":false},
  "camera":{"type":"first_person|third_person_follow|over_shoulder|top_down|fixed_gameplay|cinematic|spectator|drone|marketing_wide|detached_other","physicallyAttached":true,"gameplayCameraJustified":true,"visibleEvidence":"..."},
  "playerInput":{"input":"specific mouse/keyboard/controller input or held action","visibleEvidence":"how the viewer can infer it","visible":true},
  "playerAction":{"action":"what the controllable player does","target":"what they act on"},
  "worldResponse":{"response":"immediate visible game-world response","causalResponseVisible":true},
  "gameplayAffordances":[{"type":"hands|held_tool|crosshair|interaction_outline|stamina|angle_meter|inventory_hotbar|object_state|contextual_prompt|other","visible":true,"meaningful":true,"informationUsedByPlayer":"what decision/action this UI or object state supports"}],
  "coop":{"dependencyVisible":true,"teammateFunction":"specific dependent function","visualEvidence":"how dependency is visible without narration"},
  "physics":{"event":"...","consistent":true,"affectedEntities":["..."],"exceptions":[{"entity":"...","reason":"...","visualEvidence":"visible anchor/harness/clamp/etc"}]},
  "readability":{"primaryActionReadable":true,"visibleGoal":true,"riskExpected":true,"visibleRisk":true,"visualClutter":"low|medium|high"}
}.
Do NOT invent a decorative HUD as an affordance. If a UI element does not carry information the player uses, set meaningful:false. Any entity exempt from the same physics event must have a visible physical reason.`;
}

function schemaInstructions(durationSec: number, imageModel: DiscoveryImageModel): string {
  return `Return ONLY JSON {"shots":[...]}. Each shot must satisfy Gameplay Shot v1 exactly:\n- schema:"gameplay_shot", version:1, shotId, momentId, order:0\n- durationSec:${durationSec}\n- purpose:"mechanic"|"failure"|"payoff" (prefer mechanic/failure for first evidence)\n- actors:string[] with all mechanically relevant player roles visible or represented inside the playable frame\n- action, camera, environment\n- continuity:{preserve:[]}\n- expectedEvidence:string[]\n- generationPlan:{keyframeRequired:true,imageModel:"${imageModel}",videoModel:"${PRIMARY_GAMEPLAY_VIDEO_MODEL}",videoMode:"image-to-video",aspectRatio:"16:9",durationSec:${durationSec}}\n- metadata.gameplayAuthenticityPlan is REQUIRED.\nFor each moment, copy EVERY string from moment.requiredVisualEvidence verbatim into shot.expectedEvidence. Produce exactly one shot per moment.\n\n${authenticityInstructions()}`;
}

function prompt(input: {
  objective: DiscoveryObjectiveSpecV1;
  concepts: CoopGameConceptSpecV1[];
  moments: GameplayMomentSpecV1[];
  feedback: DiscoveryFeedbackMemory;
  durationSec: number;
  imageModel: DiscoveryImageModel;
}): string {
  return `Plan one ${input.durationSec}-second fake-gameplay evidence shot for each selected gameplay moment. This is not a trailer shot. It must be plausible as a frame recorded by a person actively playing the game.\n\nDISCOVERY OBJECTIVE:\n${JSON.stringify(input.objective, null, 2)}\n\nSELECTED CONCEPTS:\n${JSON.stringify(input.concepts, null, 2)}\n\nGAMEPLAY MOMENTS:\n${JSON.stringify(input.moments, null, 2)}\n\nPERSISTED HUMAN FEEDBACK MEMORY:\n${JSON.stringify(input.feedback, null, 2)}\n\nRules:\n- source gameplay is always composed as a normal widescreen 16:9 desktop PC capture, like a 1920x1080 gaming monitor; never compose the generated gameplay source for portrait/mobile/TikTok;\n- choose an explicit controllable player; the camera belongs to that player's gameplay viewpoint;\n- default to first-person, third-person follow, or over-the-shoulder; top-down/fixed are allowed only when actually justified by the game design;\n- forbid cinematic, spectator, drone, marketing-wide, detached observer framing;\n- expose a visible PLAYER INPUT -> PLAYER ACTION -> WORLD RESPONSE chain;\n- include at least one meaningful gameplay affordance such as hands, held tool, crosshair, interaction outline, meter, hotbar, contextual prompt, or object state;\n- show why the teammate exists without pulling the camera into a wide marketing composition;\n- if physics affects one object/person but not another, show the physical reason for the exception;\n- show all mechanically necessary player roles or their direct visible evidence;\n- the visible consequence must fit inside one ${input.durationSec}s shot;\n- preserve the game concept; do not invent a prettier replacement mechanic;\n- obey mustShow and mustAvoid feedback; explicit previous error tags are warnings against repeating rejected patterns;\n- expectedEvidence must include every requiredVisualEvidence item verbatim so coverage is mechanically auditable;\n- use ${input.imageModel} for the 16:9 gameplay keyframe and MiniMax H3 / Hailuo 03 image-to-video through KIE for motion. Kling 3 remains a supported fallback but is not the primary generation plan.\n\n${schemaInstructions(input.durationSec, input.imageModel)}`;
}

function validateCoverage(
  shots: ShotSpecV1[],
  moments: GameplayMomentSpecV1[],
  durationSec: number,
  imageModel: DiscoveryImageModel,
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
      Math.abs(shot.durationSec - durationSec) > 0.001 ||
      Math.abs(shot.generationPlan.durationSec - durationSec) > 0.001 ||
      shot.generationPlan.keyframeRequired !== true ||
      shot.generationPlan.imageModel !== imageModel ||
      shot.generationPlan.videoModel !== PRIMARY_GAMEPLAY_VIDEO_MODEL ||
      shot.generationPlan.videoMode !== "image-to-video" ||
      shot.generationPlan.aspectRatio !== "16:9"
    ) {
      issues.push(`invalid_generation_plan:${moment.momentId}`);
    }

    try {
      const authenticity = gameplayAuthenticitySpecFromShot(shot);
      if (authenticity.shotId !== shot.shotId || authenticity.momentId !== shot.momentId) {
        issues.push(`authenticity_lineage_mismatch:${moment.momentId}`);
      }
      for (const failure of authenticity.hardFailures) {
        issues.push(`gameplay_authenticity_failure:${moment.momentId}:${failure}`);
      }
      if (!authenticity.passed) {
        issues.push(
          `gameplay_authenticity_score_failed:${moment.momentId}:${authenticity.averageScore.toFixed(3)}`,
        );
      }
    } catch (error) {
      issues.push(
        `gameplay_authenticity_contract_invalid:${moment.momentId}:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (byMoment.size !== moments.length) issues.push(`shot_count_mismatch:${byMoment.size}/${moments.length}`);
  return [...new Set(issues)];
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
  durationSec: number;
  imageModel: DiscoveryImageModel;
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
    return parse(response.text).map((shot) => normalizeGenerationPolicy(shot, input.durationSec, input.imageModel));
  } catch (firstError) {
    const repairPolicy = getDiscoveryLlmPolicy("schema_repair");
    const repair = await input.llm.generate({
      model: input.repairModel,
      system: "Repair JSON/schema only. Preserve the shot plan semantics. Return JSON only.",
      prompt: `Repair the following shot response into valid ShotSpec v1 objects including the required gameplayAuthenticityPlan evidence. Keep durationSec=${input.durationSec}, imageModel=${input.imageModel}, videoModel=${PRIMARY_GAMEPLAY_VIDEO_MODEL} and aspectRatio=16:9. Do not redesign the shots.\n\nINVALID RESPONSE:\n${response.text}\n\n${schemaInstructions(input.durationSec, input.imageModel)}`,
      maxTokens: repairPolicy.maxOutputTokens,
      thinking: false,
      signal: input.signal,
    });
    input.hashes.push(hash(repair.text));
    addUsage(input.usage, repair);
    try {
      return parse(repair.text).map((shot) => normalizeGenerationPolicy(shot, input.durationSec, input.imageModel));
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
  const durationSec = gameplayDurationSeconds(input.objective);
  const imageModel = preferredDiscoveryImageModel(input.objective);
  const hashes: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const system =
    "You are the economical Shot Planner inside an AI Co-op Game Discovery Factory. Plan readable, physically plausible gameplay evidence, not cinematic advertising. You must make the controllable player, player input, world response and teammate dependency explicit enough for deterministic code to audit before any image provider is called.";
  const basePrompt = prompt({ ...input, feedback, durationSec, imageModel });

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
    durationSec,
    imageModel,
  });

  let issues = validateCoverage(shots, input.moments, durationSec, imageModel);
  let escalated = false;
  if (issues.length && policy.automaticEscalation && policy.fallbackModels.length) {
    escalated = true;
    const fallbackModel = policy.fallbackModels[0]!;
    shots = await generateAndParse({
      llm: input.llm,
      model: fallbackModel,
      system,
      prompt: `${basePrompt}\n\nThe cheap draft failed deterministic gameplay-authenticity/evidence checks. Revise the shot itself so these exact defects are visibly solved. Do not merely change booleans in metadata and do not replace the concept:\n${JSON.stringify(issues, null, 2)}`,
      maxTokens: policy.maxOutputTokens,
      thinking: true,
      signal: input.signal,
      hashes,
      usage,
      repairModel: repairPolicy.primaryModel,
      durationSec,
      imageModel,
    });
    issues = validateCoverage(shots, input.moments, durationSec, imageModel);
  }

  if (issues.length) {
    throw new Error(`SHOT_PLANNER_GAMEPLAY_AUTHENTICITY_INVALID:${issues.join("|")}`);
  }

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
