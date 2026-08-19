import { z } from "zod";

const nonEmptyText = z.string().trim().min(1);
const shortText = nonEmptyText.max(240);
const identifier = z.string().trim().min(1).max(160);
const metadataSchema = z.record(z.string(), z.unknown()).default({});

const buildabilityLevelSchema = z.enum(["low", "medium", "high"]);

export const discoveryObjectiveSpecV1Schema = z
  .object({
    schema: z.literal("discovery_objective"),
    version: z.literal(1),
    objectiveId: identifier,
    title: shortText,
    searchIntent: nonEmptyText.max(4_000),
    playerCount: z
      .object({
        min: z.literal(2),
        max: z.literal(4),
      })
      .strict(),
    platform: z.literal("pc_steam"),
    desiredNovelty: z.enum(["explore", "balanced", "exploit"]),
    conceptCount: z.number().int().min(2).max(12).default(6),
    maxConceptsToPrototype: z.number().int().min(1).max(4).default(2),
    constraints: z
      .object({
        maxMvpMonths: z.number().int().min(1).max(24).optional(),
        networkingComplexity: z.enum(["low", "medium"]).optional(),
        contentBurden: z.enum(["low", "medium"]).optional(),
        npcAiDependency: z.enum(["avoid", "allow_light"]).optional(),
        forbiddenPatterns: z.array(shortText).max(50).optional(),
      })
      .strict()
      .default({}),
    searchSpace: z
      .object({
        dependencyTypes: z.array(shortText).max(30).optional(),
        socialTensions: z.array(shortText).max(30).optional(),
        tempos: z.array(shortText).max(30).optional(),
        cameras: z.array(shortText).max(30).optional(),
        failureSignatures: z.array(shortText).max(30).optional(),
      })
      .strict()
      .optional(),
    metadata: metadataSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.maxConceptsToPrototype > value.conceptCount) {
      ctx.addIssue({
        code: "custom",
        path: ["maxConceptsToPrototype"],
        message: "maxConceptsToPrototype cannot exceed conceptCount",
      });
    }
  });

const playerRoleSchema = z
  .object({
    role: shortText,
    responsibility: nonEmptyText.max(1_000),
    information: nonEmptyText.max(1_000).optional(),
    power: nonEmptyText.max(1_000).optional(),
  })
  .strict();

const noveltyAxisSchema = z
  .object({
    axis: shortText,
    choice: shortText,
    whyDifferent: nonEmptyText.max(1_000),
  })
  .strict();

const referenceInfluenceSchema = z
  .object({
    reference: shortText,
    borrowedPrinciple: nonEmptyText.max(1_000),
    mustNotCopy: nonEmptyText.max(1_000),
  })
  .strict();

export const coopGameConceptSpecV1Schema = z
  .object({
    schema: z.literal("coop_game_concept"),
    version: z.literal(1),
    conceptId: identifier,
    oneSentencePitch: nonEmptyText.max(500),
    coreMechanic: nonEmptyText.max(2_000),
    coopDependency: nonEmptyText.max(2_000),
    playerRoles: z.array(playerRoleSchema).min(1).max(8),
    playerCount: z
      .object({
        min: z.number().int().min(2).max(4),
        max: z.number().int().min(2).max(4),
        ideal: z.number().int().min(2).max(4),
      })
      .strict(),
    interactionModel: z.array(shortText).min(1).max(12),
    failureMode: nonEmptyText.max(2_000),
    socialMoment: nonEmptyText.max(2_000),
    gameplayHook: nonEmptyText.max(1_500),
    spectacle: nonEmptyText.max(1_500),
    setting: nonEmptyText.max(1_500),
    artDirection: nonEmptyText.max(1_500),
    camera: nonEmptyText.max(1_000),
    readability: nonEmptyText.max(1_500),
    noveltyAxes: z.array(noveltyAxisSchema).min(2).max(20),
    buildability: z
      .object({
        networking: buildabilityLevelSchema,
        physics: buildabilityLevelSchema,
        contentBurden: buildabilityLevelSchema,
        npcAiDependency: z.enum(["none", "light", "heavy"]),
        systemicInteractions: buildabilityLevelSchema,
        mainRisks: z.array(shortText).max(20),
        mvpRead: nonEmptyText.max(2_000),
      })
      .strict(),
    referenceInfluences: z.array(referenceInfluenceSchema).max(20).default([]),
    metadata: metadataSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { min, max, ideal } = value.playerCount;
    if (min > max) {
      ctx.addIssue({
        code: "custom",
        path: ["playerCount", "min"],
        message: "playerCount.min cannot exceed playerCount.max",
      });
    }
    if (ideal < min || ideal > max) {
      ctx.addIssue({
        code: "custom",
        path: ["playerCount", "ideal"],
        message: "playerCount.ideal must fall within min/max",
      });
    }
  });

const playerActionSchema = z
  .object({
    role: shortText,
    action: nonEmptyText.max(1_500),
    dependencyOnOthers: nonEmptyText.max(1_500),
  })
  .strict();

export const gameplayMomentSpecV1Schema = z
  .object({
    schema: z.literal("gameplay_moment"),
    version: z.literal(1),
    momentId: identifier,
    conceptId: identifier,
    hypothesis: nonEmptyText.max(2_000),
    durationTargetSec: z.number().min(3).max(30),
    setup: nonEmptyText.max(2_000),
    playerActions: z.array(playerActionSchema).min(2).max(8),
    coopDependencyEvidence: nonEmptyText.max(2_000),
    socialTension: nonEmptyText.max(1_500),
    successBeat: nonEmptyText.max(1_500).optional(),
    failureBeat: nonEmptyText.max(1_500).optional(),
    expectedViewerUnderstanding: nonEmptyText.max(2_000),
    cameraIntent: nonEmptyText.max(1_500),
    requiredVisualEvidence: z.array(shortText).min(1).max(20),
    metadata: metadataSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.successBeat && !value.failureBeat) {
      ctx.addIssue({
        code: "custom",
        path: ["failureBeat"],
        message: "A gameplay moment needs at least a successBeat or failureBeat",
      });
    }
  });

const shotContinuitySchema = z
  .object({
    previousShotId: identifier.optional(),
    preserve: z.array(shortText).max(30).default([]),
  })
  .strict();

const shotGenerationPlanSchema = z
  .object({
    keyframeRequired: z.boolean(),
    imageModel: z
      .enum(["gpt-image-2", "nano-banana-2", "nano-banana-pro"])
      .optional(),
    videoModel: shortText,
    videoMode: z.enum(["text-to-video", "image-to-video"]),
    aspectRatio: z.literal("16:9"),
    durationSec: z.number().min(3).max(15),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.keyframeRequired && !value.imageModel) {
      ctx.addIssue({
        code: "custom",
        path: ["imageModel"],
        message: "imageModel is required when keyframeRequired is true",
      });
    }
    if (value.keyframeRequired && value.videoMode !== "image-to-video") {
      ctx.addIssue({
        code: "custom",
        path: ["videoMode"],
        message: "keyframeRequired requires image-to-video mode",
      });
    }
  });

export const shotSpecV1Schema = z
  .object({
    schema: z.literal("gameplay_shot"),
    version: z.literal(1),
    shotId: identifier,
    momentId: identifier,
    order: z.number().int().min(0).max(20),
    durationSec: z.number().min(1).max(15),
    purpose: z.enum(["hook", "mechanic", "escalation", "failure", "payoff"]),
    actors: z.array(shortText).min(1).max(20),
    action: nonEmptyText.max(2_000),
    camera: nonEmptyText.max(1_500),
    environment: nonEmptyText.max(1_500),
    continuity: shotContinuitySchema,
    expectedEvidence: z.array(shortText).min(1).max(20),
    generationPlan: shotGenerationPlanSchema,
    metadata: metadataSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Math.abs(value.durationSec - value.generationPlan.durationSec) > 0.001) {
      ctx.addIssue({
        code: "custom",
        path: ["generationPlan", "durationSec"],
        message: "generationPlan.durationSec must match shot durationSec",
      });
    }
  });

export const promptPlanV1Schema = z
  .object({
    schema: z.literal("prompt_plan"),
    version: z.literal(1),
    conceptId: identifier,
    momentId: identifier,
    shotId: identifier,
    imagePrompt: nonEmptyText.max(8_000).optional(),
    videoPrompt: nonEmptyText.max(8_000),
    negativeConstraints: z.array(shortText).max(50).default([]),
    compilerInputsHash: z.string().trim().min(16).max(256),
    providerModel: shortText,
    metadata: metadataSchema.optional(),
  })
  .strict();

const assetNodeSchema = z
  .object({
    id: identifier,
    kind: z.enum(["concept", "moment", "shot", "image", "video", "short"]),
    creativeRunId: identifier.optional(),
    generationId: identifier.optional(),
    driveFileId: identifier.optional(),
  })
  .strict();

const assetEdgeSchema = z
  .object({
    from: identifier,
    to: identifier,
    relation: z.enum(["plans", "keyframe_for", "animates", "assembles_into", "evidence_for"]),
  })
  .strict();

export const assetGraphV1Schema = z
  .object({
    schema: z.literal("asset_graph"),
    version: z.literal(1),
    objectiveRunId: identifier,
    conceptRunId: identifier,
    nodes: z.array(assetNodeSchema).min(2).max(500),
    edges: z.array(assetEdgeSchema).min(1).max(1_000),
    metadata: metadataSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const nodeIds = new Set(value.nodes.map((node) => node.id));
    if (nodeIds.size !== value.nodes.length) {
      ctx.addIssue({
        code: "custom",
        path: ["nodes"],
        message: "Asset graph node IDs must be unique",
      });
    }

    for (const [index, edge] of value.edges.entries()) {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        ctx.addIssue({
          code: "custom",
          path: ["edges", index],
          message: "Asset graph edges must reference existing nodes",
        });
      }
    }
  });

export const conceptPreEvaluationV1Schema = z
  .object({
    schema: z.literal("concept_pre_evaluation"),
    version: z.literal(1),
    conceptId: identifier,
    coOpDependency: z.enum(["pass", "fail"]),
    instantReadability: z.enum(["pass", "fail"]),
    buildability: z.enum(["pass", "fail"]),
    rejectionReasons: z.array(shortText).max(20).default([]),
    cautionFlags: z.array(shortText).max(20).default([]),
    metadata: metadataSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const failed =
      value.coOpDependency === "fail" ||
      value.instantReadability === "fail" ||
      value.buildability === "fail";
    if (failed && value.rejectionReasons.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["rejectionReasons"],
        message: "Failed pre-evaluations require at least one rejection reason",
      });
    }
  });

export type DiscoveryObjectiveSpecV1 = z.infer<typeof discoveryObjectiveSpecV1Schema>;
export type CoopGameConceptSpecV1 = z.infer<typeof coopGameConceptSpecV1Schema>;
export type GameplayMomentSpecV1 = z.infer<typeof gameplayMomentSpecV1Schema>;
export type ShotSpecV1 = z.infer<typeof shotSpecV1Schema>;
export type PromptPlanV1 = z.infer<typeof promptPlanV1Schema>;
export type AssetGraphV1 = z.infer<typeof assetGraphV1Schema>;
export type ConceptPreEvaluationV1 = z.infer<typeof conceptPreEvaluationV1Schema>;

export const gameDiscoveryDomainSchemas = {
  discoveryObjective: discoveryObjectiveSpecV1Schema,
  coopGameConcept: coopGameConceptSpecV1Schema,
  gameplayMoment: gameplayMomentSpecV1Schema,
  shot: shotSpecV1Schema,
  promptPlan: promptPlanV1Schema,
  assetGraph: assetGraphV1Schema,
  conceptPreEvaluation: conceptPreEvaluationV1Schema,
} as const;