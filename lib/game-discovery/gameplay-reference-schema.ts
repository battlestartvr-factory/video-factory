import { z } from "zod";

const nonEmptyText = z.string().trim().min(1);
const shortText = nonEmptyText.max(240);
const identifier = z.string().trim().min(1).max(160);
const optionalText = z.string().trim().min(1).max(2_000).nullable().optional();
const optionalBoolean = z.boolean().nullable().optional();
const optionalDateTime = z.string().datetime({ offset: true }).nullable().optional();
const metadataSchema = z.record(z.string(), z.unknown()).default({});

export const gameplayReferenceMediaTypeSchema = z.enum(["image", "video_segment"]);

export const gameplayReferenceSourceTypeSchema = z.enum([
  "official_steam_screenshot",
  "developer_gameplay",
  "official_gameplay_trailer",
  "developer_youtube",
  "gameplay_capture",
  "manual_drive_upload",
  "other",
]);

export const gameplayReferenceCameraTypeSchema = z.enum([
  "first_person",
  "third_person_follow",
  "over_shoulder",
  "top_down",
  "fixed_gameplay",
  "other",
]);

export const gameplayReferenceProductionScopeFeelSchema = z.enum(["indie", "AA", "AAA"]);

export const gameplayReferencePurposeSchema = z.enum([
  "gameplay_camera",
  "interaction",
  "coop",
  "art_direction",
]);

export const gameplayReferenceSpecV1Schema = z
  .object({
    schema: z.literal("gameplay_reference"),
    version: z.literal(1),

    referenceId: identifier,
    gameId: identifier,
    gameName: shortText,
    mediaType: gameplayReferenceMediaTypeSchema,
    sourceType: gameplayReferenceSourceTypeSchema,
    sourceUrl: z.string().trim().url().max(4_000),
    sourceTimestampMs: z.number().int().nonnegative().nullable().optional(),
    capturedAt: optionalDateTime,
    observedAt: z.string().datetime({ offset: true }),
    driveFileId: identifier,
    mimeType: shortText,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationMs: z.number().int().positive().nullable().optional(),

    cameraType: gameplayReferenceCameraTypeSchema,
    cameraDistance: optionalText,
    cameraHeight: optionalText,
    fovEstimate: z.number().min(1).max(180).nullable().optional(),
    playableCharacterVisible: optionalBoolean,
    handsVisible: optionalBoolean,
    heldToolVisible: optionalBoolean,
    crosshairVisible: optionalBoolean,
    hudVisible: optionalBoolean,

    controllablePlayerObvious: z.boolean(),
    howPlayerControlIsVisible: nonEmptyText.max(2_000),
    currentPlayerAction: nonEmptyText.max(2_000),
    visibleInputAffordance: nonEmptyText.max(2_000),
    playerTarget: optionalText,
    gameResponse: nonEmptyText.max(2_000),

    teammateCountVisible: z.number().int().min(0).max(16),
    teammateDistance: optionalText,
    teammateRole: optionalText,
    coopDependencyVisible: z.boolean(),
    sharedObjectVisible: z.boolean(),
    informationAsymmetryVisible: z.boolean(),
    rescueVisible: z.boolean(),
    coordinationVisible: z.boolean(),

    coreAction: nonEmptyText.max(2_000),
    mechanicTags: z.array(shortText).max(40).default([]),
    interactionModel: z.array(shortText).max(20).default([]),
    dangerSource: optionalText,
    failureRisk: optionalText,
    successState: optionalText,
    physicsInteraction: optionalText,
    environmentType: optionalText,

    primaryFocus: nonEmptyText.max(1_500),
    secondaryFocus: optionalText,
    readableWithoutContext: z.boolean(),
    visibleGoal: z.boolean(),
    visibleRisk: z.boolean(),
    uiSupportsAction: z.boolean(),
    visualClutter: z.enum(["low", "medium", "high"]),

    artDirection: nonEmptyText.max(2_000),
    realismLevel: shortText,
    productionScopeFeel: gameplayReferenceProductionScopeFeelSchema,
    stylizationTags: z.array(shortText).max(40).default([]),

    gameplayDescription: nonEmptyText.min(30).max(4_000),
    whyThisLooksLikeGameplay: nonEmptyText.min(20).max(2_000),

    contentSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
    perceptualHash: z.string().trim().min(8).max(256).nullable().optional(),
    canonicalReferenceId: identifier.nullable().optional(),
    dedupeReason: optionalText,
    embeddingModel: shortText.nullable().optional(),
    embeddingDimensions: z.number().int().positive().max(8_192).nullable().optional(),

    metadata: metadataSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mediaType === "video_segment" && !value.durationMs) {
      ctx.addIssue({
        code: "custom",
        path: ["durationMs"],
        message: "durationMs is required for video_segment references",
      });
    }

    if (value.mediaType === "image" && value.durationMs != null) {
      ctx.addIssue({
        code: "custom",
        path: ["durationMs"],
        message: "durationMs must be null/omitted for image references",
      });
    }

    if (value.canonicalReferenceId === value.referenceId) {
      ctx.addIssue({
        code: "custom",
        path: ["canonicalReferenceId"],
        message: "canonicalReferenceId must point to another reference or be null",
      });
    }
  });

export type GameplayReferenceSpecV1 = z.infer<typeof gameplayReferenceSpecV1Schema>;
export type GameplayReferenceMediaType = z.infer<typeof gameplayReferenceMediaTypeSchema>;
export type GameplayReferencePurpose = z.infer<typeof gameplayReferencePurposeSchema>;
