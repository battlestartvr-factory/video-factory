import { z } from "zod";
import {
  gameplayReferenceSpecV1Schema,
  type GameplayReferenceSpecV1,
} from "./gameplay-reference-schema";

const requiredText = z.string().trim().min(1).max(2_000);
const optionalText = z.string().trim().min(1).max(2_000).nullable().optional();
const tag = z.string().trim().min(1).max(240);

export const GAMEPLAY_REFERENCE_NONE_VISIBLE = "none_visible";

/**
 * Output contract for the cheap vision captioner. Identity/provenance is never delegated to
 * the model; it is joined back from the pending database row after deterministic validation.
 */
export const gameplayReferenceCaptionV1Schema = z
  .object({
    cameraType: z.enum([
      "first_person",
      "third_person_follow",
      "over_shoulder",
      "top_down",
      "fixed_gameplay",
      "other",
    ]),
    cameraDistance: optionalText,
    cameraHeight: optionalText,
    fovEstimate: z.number().min(1).max(180).nullable().optional(),
    playableCharacterVisible: z.boolean().nullable().optional(),
    handsVisible: z.boolean().nullable().optional(),
    heldToolVisible: z.boolean().nullable().optional(),
    crosshairVisible: z.boolean().nullable().optional(),
    hudVisible: z.boolean().nullable().optional(),

    controllablePlayerObvious: z.boolean(),
    howPlayerControlIsVisible: requiredText,
    currentPlayerAction: requiredText,
    visibleInputAffordance: requiredText,
    playerTarget: optionalText,
    gameResponse: requiredText,

    teammateCountVisible: z.number().int().min(0).max(16),
    teammateDistance: optionalText,
    teammateRole: optionalText,
    coopDependencyVisible: z.boolean(),
    sharedObjectVisible: z.boolean(),
    informationAsymmetryVisible: z.boolean(),
    rescueVisible: z.boolean(),
    coordinationVisible: z.boolean(),

    coreAction: requiredText,
    mechanicTags: z.array(tag).max(40).default([]),
    interactionModel: z.array(tag).max(20).default([]),
    dangerSource: optionalText,
    failureRisk: optionalText,
    successState: optionalText,
    physicsInteraction: optionalText,
    environmentType: optionalText,

    primaryFocus: z.string().trim().min(1).max(1_500),
    secondaryFocus: z.string().trim().min(1).max(1_500).nullable().optional(),
    readableWithoutContext: z.boolean(),
    visibleGoal: z.boolean(),
    visibleRisk: z.boolean(),
    uiSupportsAction: z.boolean(),
    visualClutter: z.enum(["low", "medium", "high"]),

    artDirection: requiredText,
    realismLevel: tag,
    productionScopeFeel: z.enum(["indie", "AA", "AAA"]),
    stylizationTags: z.array(tag).max(40).default([]),

    gameplayDescription: z.string().trim().min(30).max(4_000),
    whyThisLooksLikeGameplay: z.string().trim().min(20).max(2_000),
  })
  .strict();

export type GameplayReferenceCaptionV1 = z.infer<typeof gameplayReferenceCaptionV1Schema>;

export interface PendingGameplayReferenceIdentity {
  referenceId: string;
  gameId: string;
  gameName: string;
  mediaType: "image" | "video_segment";
  sourceType:
    | "official_steam_screenshot"
    | "developer_gameplay"
    | "official_gameplay_trailer"
    | "developer_youtube"
    | "gameplay_capture"
    | "other";
  sourceUrl: string;
  sourceTimestampMs?: number | null;
  capturedAt?: string | null;
  observedAt: string;
  driveFileId: string;
  mimeType: string;
  width: number;
  height: number;
  durationMs?: number | null;
  contentSha256?: string | null;
  perceptualHash?: string | null;
  canonicalReferenceId?: string | null;
  dedupeReason?: string | null;
  metadata?: Record<string, unknown>;
}

function normalizeBoolean(value: unknown): unknown {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (["true", "yes", "y", "visible", "present"].includes(normalized)) return true;
  if (
    [
      "false",
      "no",
      "n",
      "not visible",
      "none",
      "absent",
      "unknown",
      "unclear",
      "not clear",
      "not clearly visible",
      "n/a",
    ].includes(normalized)
  ) {
    return false;
  }
  if (normalized.startsWith("yes ")) return true;
  if (normalized.startsWith("no ") || normalized.includes("not visible")) return false;
  return value;
}

function normalizeNumber(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value.trim()) return value;
  const trimmed = value.trim();
  const exact = Number(trimmed);
  if (Number.isFinite(exact)) return exact;
  const firstNumericToken = trimmed.match(/-?\d+(?:\.\d+)?/)?.[0];
  if (!firstNumericToken) return value;
  const parsed = Number(firstNumericToken);
  return Number.isFinite(parsed) ? parsed : value;
}

function normalizeOptionalText(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeRequiredVisibleText(value: unknown): unknown {
  if (value == null) return GAMEPLAY_REFERENCE_NONE_VISIBLE;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed || GAMEPLAY_REFERENCE_NONE_VISIBLE;
}

function normalizeStringArray(value: unknown): unknown {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
  }
  if (typeof value === "string") {
    return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  }
  return value;
}

function normalizeCameraType(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, string> = {
    fp: "first_person",
    firstperson: "first_person",
    first_person: "first_person",
    third_person: "third_person_follow",
    thirdperson: "third_person_follow",
    third_person_follow: "third_person_follow",
    over_the_shoulder: "over_shoulder",
    over_shoulder: "over_shoulder",
    top_down: "top_down",
    fixed: "fixed_gameplay",
    fixed_gameplay: "fixed_gameplay",
    other: "other",
  };
  return aliases[key] ?? value;
}

function normalizeScope(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const key = value.trim().toLowerCase();
  if (key === "indie") return "indie";
  if (key === "aa") return "AA";
  if (key === "aaa") return "AAA";
  return value;
}

function normalizeClutter(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const key = value.trim().toLowerCase();
  return ["low", "medium", "high"].includes(key) ? key : value;
}

const BOOLEAN_FIELDS = [
  "playableCharacterVisible",
  "handsVisible",
  "heldToolVisible",
  "crosshairVisible",
  "hudVisible",
  "controllablePlayerObvious",
  "coopDependencyVisible",
  "sharedObjectVisible",
  "informationAsymmetryVisible",
  "rescueVisible",
  "coordinationVisible",
  "readableWithoutContext",
  "visibleGoal",
  "visibleRisk",
  "uiSupportsAction",
] as const;

const OPTIONAL_TEXT_FIELDS = [
  "cameraDistance",
  "cameraHeight",
  "playerTarget",
  "teammateDistance",
  "teammateRole",
  "dangerSource",
  "failureRisk",
  "successState",
  "physicsInteraction",
  "environmentType",
  "secondaryFocus",
] as const;

export function normalizeGameplayReferenceCaptionPayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized: Record<string, unknown> = { ...(value as Record<string, unknown>) };

  normalized.cameraType = normalizeCameraType(normalized.cameraType);
  normalized.productionScopeFeel = normalizeScope(normalized.productionScopeFeel);
  normalized.visualClutter = normalizeClutter(normalized.visualClutter);
  normalized.fovEstimate = normalizeNumber(normalized.fovEstimate);
  normalized.teammateCountVisible = normalizeNumber(normalized.teammateCountVisible);
  normalized.visibleInputAffordance = normalizeRequiredVisibleText(
    normalized.visibleInputAffordance,
  );
  normalized.mechanicTags = normalizeStringArray(normalized.mechanicTags);
  normalized.interactionModel = normalizeStringArray(normalized.interactionModel);
  normalized.stylizationTags = normalizeStringArray(normalized.stylizationTags);

  for (const field of BOOLEAN_FIELDS) normalized[field] = normalizeBoolean(normalized[field]);
  for (const field of OPTIONAL_TEXT_FIELDS) normalized[field] = normalizeOptionalText(normalized[field]);

  return normalized;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(fenced) as unknown;
  } catch {
    const start = fenced.indexOf("{");
    const end = fenced.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("GAMEPLAY_REFERENCE_CAPTION_JSON_NOT_FOUND");
    return JSON.parse(fenced.slice(start, end + 1)) as unknown;
  }
}

export function parseGameplayReferenceCaption(text: string): GameplayReferenceCaptionV1 {
  const parsed = extractJsonObject(text);
  const normalized = normalizeGameplayReferenceCaptionPayload(parsed);
  return gameplayReferenceCaptionV1Schema.parse(normalized);
}

export function materializeGameplayReferenceSpec(input: {
  identity: PendingGameplayReferenceIdentity;
  caption: GameplayReferenceCaptionV1;
  embeddingModel?: string | null;
  embeddingDimensions?: number | null;
}): GameplayReferenceSpecV1 {
  return gameplayReferenceSpecV1Schema.parse({
    schema: "gameplay_reference",
    version: 1,
    ...input.identity,
    ...input.caption,
    embeddingModel: input.embeddingModel ?? null,
    embeddingDimensions: input.embeddingDimensions ?? null,
    metadata: input.identity.metadata ?? {},
  });
}

export function buildGameplayReferenceCaptionPrompt(gameName: string): string {
  return `Analyze this image as a candidate REAL PC GAMEPLAY reference for ${gameName}. Return one JSON object only, with no prose or markdown.\n\nDo not infer marketing intent from the game name. Inspect only what is visibly supported by the frame. A gameplay screenshot is not key art, concept art, a cinematic trailer frame, photo mode, or a detached spectator composition.\n\nRequired fields:\n- cameraType: first_person | third_person_follow | over_shoulder | top_down | fixed_gameplay | other\n- cameraDistance, cameraHeight, fovEstimate, playableCharacterVisible, handsVisible, heldToolVisible, crosshairVisible, hudVisible\n- controllablePlayerObvious, howPlayerControlIsVisible, currentPlayerAction, visibleInputAffordance, playerTarget, gameResponse\n- teammateCountVisible, teammateDistance, teammateRole, coopDependencyVisible, sharedObjectVisible, informationAsymmetryVisible, rescueVisible, coordinationVisible\n- coreAction, mechanicTags[], interactionModel[], dangerSource, failureRisk, successState, physicsInteraction, environmentType\n- primaryFocus, secondaryFocus, readableWithoutContext, visibleGoal, visibleRisk, uiSupportsAction, visualClutter: low | medium | high\n- artDirection, realismLevel, productionScopeFeel: indie | AA | AAA, stylizationTags[]\n- gameplayDescription: concrete description of what the controllable player is doing now, what is in front of them, what a teammate is doing, where the risk is, and what UI/affordance helps read the action\n- whyThisLooksLikeGameplay: concrete evidence that the camera, player embodiment, interaction distance, affordance, teammate framing, and world response read as active gameplay.\n\nType rules: all visibility/readability flags must be JSON booleans true/false, never descriptive strings. fovEstimate must be a JSON number in degrees or null, never a string. visibleInputAffordance must always be a string; use the literal string ${GAMEPLAY_REFERENCE_NONE_VISIBLE} if no explicit input affordance is visible. Use null only for genuinely unobservable optional text/number values. Do not invent a HUD, input, teammate, risk, or physical response that is not visible.`;
}

export function buildGameplayReferenceEmbeddingText(reference: GameplayReferenceSpecV1): string {
  return [
    `camera:${reference.cameraType}`,
    `player_action:${reference.currentPlayerAction}`,
    `input_affordance:${reference.visibleInputAffordance}`,
    `target:${reference.playerTarget ?? "none"}`,
    `world_response:${reference.gameResponse}`,
    `coop:${reference.coopDependencyVisible ? "visible" : "not_visible"}`,
    `teammate_role:${reference.teammateRole ?? "none"}`,
    `core_action:${reference.coreAction}`,
    `mechanics:${reference.mechanicTags.join(",")}`,
    `interaction:${reference.interactionModel.join(",")}`,
    `physics:${reference.physicsInteraction ?? "none"}`,
    `risk:${reference.failureRisk ?? reference.dangerSource ?? "none"}`,
    `environment:${reference.environmentType ?? "unknown"}`,
    `style:${reference.artDirection}; ${reference.productionScopeFeel}; ${reference.stylizationTags.join(",")}`,
    `description:${reference.gameplayDescription}`,
    `gameplay_evidence:${reference.whyThisLooksLikeGameplay}`,
  ].join("\n");
}
