import "server-only";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentProvider } from "@/lib/agent/provider";
import type { AgentUsage } from "@/lib/agent/types";
import { getDriveStorageProvider } from "@/lib/storage/drive-provider";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { GameplayAuthenticitySpecV1 } from "./gameplay-authenticity";
import {
  evaluateGameplayImageAuthenticityInspection,
  evaluateGameplayVideoAuthenticityInspection,
  gameplayImageAuthenticityInspectionV1Schema,
  gameplayImageAuthenticityObservationV1Schema,
  gameplayVideoAuthenticityInspectionV1Schema,
  gameplayVideoAuthenticityObservationV1Schema,
  type GameplayImageAuthenticityInspectionV1,
  type GameplayVideoAuthenticityInspectionV1,
} from "./gameplay-authenticity-inspection";
import { uploadGameplayReferenceToKieTemp } from "./gameplay-reference-captioner";

export const GAMEPLAY_AUTHENTICITY_INSPECTOR_MODEL = "gemini-3-6-flash";
const MAX_FRAME_COUNT = 5;
const INSPECTION_KIND_IMAGE = "generated_reference_image_v1";
const INSPECTION_KIND_VIDEO = "generated_gameplay_video_frames_v1";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bool(value: unknown): unknown {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (["true", "yes", "y", "visible", "present", "consistent", "stable"].includes(normalized)) {
    return true;
  }
  if (
    [
      "false",
      "no",
      "n",
      "not visible",
      "absent",
      "inconsistent",
      "unstable",
      "unknown",
      "unclear",
    ].includes(normalized)
  ) {
    return false;
  }
  return value;
}

function text(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const joined = value.filter((item): item is string => typeof item === "string").join("; ").trim();
    if (joined) return joined;
  }
  return fallback;
}

function textArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .slice(0, 30);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function extractJson(textValue: string): Record<string, unknown> {
  const trimmed = textValue.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim() ?? trimmed;
  try {
    return object(JSON.parse(fenced));
  } catch {
    const start = fenced.indexOf("{");
    const end = fenced.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("GAMEPLAY_AUTHENTICITY_INSPECTION_JSON_MISSING");
    return object(JSON.parse(fenced.slice(start, end + 1)));
  }
}

function usage(value?: AgentUsage) {
  return {
    promptTokens: value?.promptTokens ?? 0,
    completionTokens: value?.completionTokens ?? 0,
    totalTokens: value?.totalTokens ?? (value?.promptTokens ?? 0) + (value?.completionTokens ?? 0),
  };
}

function normalizeImageObservation(raw: Record<string, unknown>) {
  return gameplayImageAuthenticityObservationV1Schema.parse({
    couldBeActiveGameplayScreenshot: bool(raw.couldBeActiveGameplayScreenshot),
    controllablePlayerObvious: bool(raw.controllablePlayerObvious),
    controllablePlayerLocation: text(raw.controllablePlayerLocation, "No controllable-player location was identified."),
    currentPlayerAction: text(raw.currentPlayerAction, "No clear player action was identified."),
    probablePlayerInput: text(raw.probablePlayerInput, "No player input could be inferred."),
    playerInputInferable: bool(raw.playerInputInferable),
    worldResponse: text(raw.worldResponse, "No clear world response was identified."),
    worldResponseVisible: bool(raw.worldResponseVisible),
    cameraPhysicallyPlausible: bool(raw.cameraPhysicallyPlausible),
    cinematicOrPromotional: bool(raw.cinematicOrPromotional),
    gameplayAffordanceVisible: bool(raw.gameplayAffordanceVisible),
    hudPresent: bool(raw.hudPresent),
    hudMeaningfulIfPresent: bool(raw.hudMeaningfulIfPresent),
    teammateDependencyVisible: bool(raw.teammateDependencyVisible),
    physicsConsistent: bool(raw.physicsConsistent),
    primaryActionReadable: bool(raw.primaryActionReadable),
    matchesPlannedComposition: bool(raw.matchesPlannedComposition),
    defects: textArray(raw.defects),
  });
}

function normalizeVideoObservation(raw: Record<string, unknown>) {
  const cameraPhysicallyAttachedThroughout = bool(raw.cameraPhysicallyAttachedThroughout);
  const cinematicCameraMovement = bool(raw.cinematicCameraMovement);
  const cameraContinuousRaw = bool(raw.cameraContinuous);
  const cameraContinuous =
    typeof cameraContinuousRaw === "boolean"
      ? cameraContinuousRaw
      : cameraPhysicallyAttachedThroughout === true && cinematicCameraMovement === false;

  return gameplayVideoAuthenticityObservationV1Schema.parse({
    couldBeContinuousGameplayCapture: bool(raw.couldBeContinuousGameplayCapture),
    cameraContinuous,
    cameraPhysicallyAttachedThroughout,
    cinematicCameraMovement,
    handsOrToolsExpected: bool(raw.handsOrToolsExpected),
    handsToolsStableIfExpected: bool(raw.handsToolsStableIfExpected),
    hudPresent: bool(raw.hudPresent),
    hudStableIfPresent: bool(raw.hudStableIfPresent),
    teammateVisibleOrImplied: bool(raw.teammateVisibleOrImplied),
    teammateIdentityStable: bool(raw.teammateIdentityStable),
    physicsConsistent: bool(raw.physicsConsistent),
    objectTeleportation: bool(raw.objectTeleportation),
    actionsTrackVisiblePlayerInput: bool(raw.actionsTrackVisiblePlayerInput),
    actorsBehaveLikePlayers: bool(raw.actorsBehaveLikePlayers),
    referenceCompositionPreserved: bool(raw.referenceCompositionPreserved),
    worldResponseContinuous: bool(raw.worldResponseContinuous),
    defects: textArray(raw.defects),
  });
}

async function existingInspection<T>(input: {
  generationId: string;
  inspectionKind: string;
  parse: (value: unknown) => T;
}): Promise<T | null> {
  const supabase = createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("gameplay_authenticity_inspections")
    .select("inspection")
    .eq("generation_id", input.generationId)
    .eq("inspection_kind", input.inspectionKind)
    .maybeSingle();
  if (error) throw new Error(`GAMEPLAY_AUTHENTICITY_INSPECTION_READ_FAILED:${error.message}`);
  if (!data?.inspection) return null;
  return input.parse(data.inspection);
}

async function persistInspection(input: {
  rootCreativeRunId: string;
  generationId: string;
  shotId: string;
  conceptId: string;
  momentId: string;
  assetType: "image" | "video";
  inspectionKind: string;
  inspection: GameplayImageAuthenticityInspectionV1 | GameplayVideoAuthenticityInspectionV1;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const supabase = createSupabaseServiceClient();
  const { error } = await supabase.from("gameplay_authenticity_inspections").upsert(
    {
      root_creative_run_id: input.rootCreativeRunId,
      generation_id: input.generationId,
      shot_id: input.shotId,
      concept_id: input.conceptId,
      moment_id: input.momentId,
      asset_type: input.assetType,
      inspection_kind: input.inspectionKind,
      inspector_model: input.inspection.inspectorModel,
      passed: input.inspection.passed,
      average_score: input.inspection.averageScore,
      hard_failures: input.inspection.hardFailures,
      inspection: input.inspection,
      usage: input.inspection.usage,
      metadata: input.metadata ?? {},
      updated_at: new Date().toISOString(),
    },
    { onConflict: "generation_id,inspection_kind" },
  );
  if (error) throw new Error(`GAMEPLAY_AUTHENTICITY_INSPECTION_WRITE_FAILED:${error.message}`);
}

function imagePrompt(planned: GameplayAuthenticitySpecV1): string {
  return `Inspect this generated image as a strict gameplay-authenticity evaluator. Judge only visible evidence. The central question is: Could this exact image plausibly be a screenshot captured while a person is actively playing a PC game?\n\nPLANNED GAMEPLAY CONTRACT:\n${JSON.stringify(planned)}\n\nReturn strict JSON only with these exact fields:\n{
"couldBeActiveGameplayScreenshot":boolean,
"controllablePlayerObvious":boolean,
"controllablePlayerLocation":"specific visible location/body/camera evidence",
"currentPlayerAction":"specific action visible now",
"probablePlayerInput":"specific likely input/action the player is giving",
"playerInputInferable":boolean,
"worldResponse":"specific world response visible now",
"worldResponseVisible":boolean,
"cameraPhysicallyPlausible":boolean,
"cinematicOrPromotional":boolean,
"gameplayAffordanceVisible":boolean,
"hudPresent":boolean,
"hudMeaningfulIfPresent":boolean,
"teammateDependencyVisible":boolean,
"physicsConsistent":boolean,
"primaryActionReadable":boolean,
"matchesPlannedComposition":boolean,
"defects":["short specific visible defect"]
}\n\nRules:\n- A nice game-like scene is not enough. Require player embodiment and an input-driven action.\n- Cinematic/spectator/marketing framing fails camera plausibility.\n- Do not count decorative HUD as a gameplay affordance.\n- If HUD is absent, hudPresent=false and hudMeaningfulIfPresent=true.\n- Teammate dependency must be visible or directly implied by a shared object/tool/rope/beam/function.\n- Physics exceptions require a visible anchor, harness, clamp, handhold or equivalent reason.\n- Compare the generated image with the planned camera/action/teammate composition, not with any source game's identity.`;
}

function videoPrompt(planned: GameplayAuthenticitySpecV1): string {
  return `These ordered images are frame samples from one generated five-second gameplay video. Judge continuity across the sequence. The central question is: Could this exact five-second shot plausibly be recorded by a player pressing Record while actually playing this game?\n\nPLANNED GAMEPLAY CONTRACT:\n${JSON.stringify(planned)}\n\nReturn strict JSON only with these exact fields:\n{
"couldBeContinuousGameplayCapture":boolean,
"cameraContinuous":boolean,
"cameraPhysicallyAttachedThroughout":boolean,
"cinematicCameraMovement":boolean,
"handsOrToolsExpected":boolean,
"handsToolsStableIfExpected":boolean,
"hudPresent":boolean,
"hudStableIfPresent":boolean,
"teammateVisibleOrImplied":boolean,
"teammateIdentityStable":boolean,
"physicsConsistent":boolean,
"objectTeleportation":boolean,
"actionsTrackVisiblePlayerInput":boolean,
"actorsBehaveLikePlayers":boolean,
"referenceCompositionPreserved":boolean,
"worldResponseContinuous":boolean,
"defects":["short specific continuity/gameplay defect"]
}\n\nCheck for camera orbit/dolly/reframing, disappearing hands/tools, changing HUD, teammate drift, impossible physics, teleportation, actions without visible player input, actor-like staging, and loss of the approved player-camera composition. If HUD is absent, hudPresent=false and hudStableIfPresent=true.`;
}

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8_000) stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`GAMEPLAY_VIDEO_FRAME_SAMPLING_FAILED:${code}:${stderr.slice(-2_000)}`));
    });
  });
}

async function sampleVideoFrames(buffer: Buffer): Promise<Array<{ filename: string; buffer: Buffer }>> {
  const directory = await mkdtemp(join(tmpdir(), "gameplay-auth-"));
  try {
    const inputPath = join(directory, "input.mp4");
    const pattern = join(directory, "frame-%02d.jpg");
    await writeFile(inputPath, buffer);
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vf",
      "fps=1",
      "-frames:v",
      String(MAX_FRAME_COUNT),
      "-q:v",
      "3",
      pattern,
    ]);
    const names = (await readdir(directory))
      .filter((name) => /^frame-\d+\.jpg$/i.test(name))
      .sort()
      .slice(0, MAX_FRAME_COUNT);
    if (names.length < 2) throw new Error(`GAMEPLAY_VIDEO_FRAME_COUNT_INSUFFICIENT:${names.length}`);
    return Promise.all(names.map(async (filename) => ({ filename, buffer: await readFile(join(directory, filename)) })));
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function inspectGeneratedGameplayImage(input: {
  rootCreativeRunId: string;
  generationId: string;
  shotId: string;
  conceptId: string;
  momentId: string;
  driveFileId: string;
  plannedAuthenticity: GameplayAuthenticitySpecV1;
}): Promise<GameplayImageAuthenticityInspectionV1> {
  const cached = await existingInspection({
    generationId: input.generationId,
    inspectionKind: INSPECTION_KIND_IMAGE,
    parse: (value) => gameplayImageAuthenticityInspectionV1Schema.parse(value),
  });
  if (cached) return cached;

  const drive = getDriveStorageProvider();
  const [buffer, metadata] = await Promise.all([
    drive.downloadFile(input.driveFileId),
    drive.getFileMetadata(input.driveFileId),
  ]);
  const imageUrl = await uploadGameplayReferenceToKieTemp({
    referenceId: `inspection-${input.generationId}`,
    filename: metadata.filename,
    mimeType: metadata.mimeType,
    buffer,
  });
  const provider = createAgentProvider();
  const response = await provider.run({
    model: GAMEPLAY_AUTHENTICITY_INSPECTOR_MODEL,
    system:
      "You are a low-cost strict gameplay-authenticity inspector. Analyze only visible evidence. Never reward cinematic polish. Return JSON only.",
    reasoningLevel: null,
    tools: [],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: imagePrompt(input.plannedAuthenticity) },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  });
  if (!response.content) throw new Error("GAMEPLAY_IMAGE_AUTHENTICITY_INSPECTION_EMPTY");
  const observation = normalizeImageObservation(extractJson(response.content));
  const inspection = evaluateGameplayImageAuthenticityInspection({
    generationId: input.generationId,
    shotId: input.shotId,
    observation,
    inspectorModel: GAMEPLAY_AUTHENTICITY_INSPECTOR_MODEL,
    usage: usage(response.usage),
  });
  await persistInspection({
    ...input,
    assetType: "image",
    inspectionKind: INSPECTION_KIND_IMAGE,
    inspection,
    metadata: { drive_file_id: input.driveFileId },
  });
  return inspection;
}

export async function inspectGeneratedGameplayVideo(input: {
  rootCreativeRunId: string;
  generationId: string;
  shotId: string;
  conceptId: string;
  momentId: string;
  driveFileId: string;
  plannedAuthenticity: GameplayAuthenticitySpecV1;
}): Promise<GameplayVideoAuthenticityInspectionV1> {
  const cached = await existingInspection({
    generationId: input.generationId,
    inspectionKind: INSPECTION_KIND_VIDEO,
    parse: (value) => gameplayVideoAuthenticityInspectionV1Schema.parse(value),
  });
  if (cached) return cached;

  const drive = getDriveStorageProvider();
  const videoBuffer = await drive.downloadFile(input.driveFileId);
  const frames = await sampleVideoFrames(videoBuffer);
  const frameUrls = await Promise.all(
    frames.map((frame, index) =>
      uploadGameplayReferenceToKieTemp({
        referenceId: `video-inspection-${input.generationId}-f${index + 1}`,
        filename: frame.filename,
        mimeType: "image/jpeg",
        buffer: frame.buffer,
      }),
    ),
  );
  const provider = createAgentProvider();
  const response = await provider.run({
    model: GAMEPLAY_AUTHENTICITY_INSPECTOR_MODEL,
    system:
      "You are a low-cost strict evaluator of sampled frames from generated gameplay video. Analyze temporal consistency across ordered frames. Return JSON only.",
    reasoningLevel: null,
    tools: [],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: videoPrompt(input.plannedAuthenticity) },
          ...frameUrls.flatMap((url, index) => [
            { type: "text" as const, text: `Frame ${index + 1} of ${frameUrls.length}:` },
            { type: "image_url" as const, image_url: { url } },
          ]),
        ],
      },
    ],
  });
  if (!response.content) throw new Error("GAMEPLAY_VIDEO_AUTHENTICITY_INSPECTION_EMPTY");
  const observation = normalizeVideoObservation(extractJson(response.content));
  const inspection = evaluateGameplayVideoAuthenticityInspection({
    generationId: input.generationId,
    shotId: input.shotId,
    sampledFrameCount: frames.length,
    observation,
    plannedAuthenticity: input.plannedAuthenticity,
    inspectorModel: GAMEPLAY_AUTHENTICITY_INSPECTOR_MODEL,
    usage: usage(response.usage),
  });
  await persistInspection({
    ...input,
    assetType: "video",
    inspectionKind: INSPECTION_KIND_VIDEO,
    inspection,
    metadata: { drive_file_id: input.driveFileId, sampled_frame_count: frames.length },
  });
  return inspection;
}