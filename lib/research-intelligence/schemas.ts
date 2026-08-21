import { z } from "zod";

const nonEmptyText = z.string().trim().min(1);
const shortText = nonEmptyText.max(240);
const identifier = z.string().trim().min(1).max(200);
const urlSchema = z.string().url().max(4_000);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const metadataSchema = z.record(z.string(), z.unknown()).default({});

export const researchScoutRoleSchema = z.enum([
  "market_competitor",
  "mechanics",
  "player_voice",
  "gameplay_visual",
  "white_space_contrarian",
]);

export type ResearchScoutRoleV1 = z.infer<typeof researchScoutRoleSchema>;

export const researchPolicySpecV1Schema = z
  .object({
    mode: z.enum(["required", "best_effort", "disabled"]),
    freshness: z.enum(["current", "recent", "mixed"]),
    maxQueries: z.number().int().min(1).max(20).optional(),
    maxSources: z.number().int().min(1).max(30).optional(),
    maxImageCandidates: z.number().int().min(0).max(24).optional(),
    allowExternalImageReferences: z.boolean(),
    allowGameplayLibraryPromotion: z.boolean(),
    sourceDomainAllowlist: z.array(shortText).max(100).optional(),
    sourceDomainDenylist: z.array(shortText).max(100).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.sourceDomainAllowlist || !value.sourceDomainDenylist) return;
    const denied = new Set(value.sourceDomainDenylist.map((item) => item.toLowerCase()));
    for (const [index, domain] of value.sourceDomainAllowlist.entries()) {
      if (denied.has(domain.toLowerCase())) {
        ctx.addIssue({
          code: "custom",
          path: ["sourceDomainAllowlist", index],
          message: "A source domain cannot be both allowed and denied",
        });
      }
    }
  });

export const defaultResearchPolicyV1 = {
  mode: "required",
  freshness: "mixed",
  maxQueries: 20,
  maxSources: 30,
  maxImageCandidates: 24,
  allowExternalImageReferences: true,
  allowGameplayLibraryPromotion: false,
} satisfies ResearchPolicySpecV1;

const researchScoutBudgetSchema = z
  .object({
    maxSearchQueries: z.number().int().min(0).max(4),
    maxFetchedSources: z.number().int().min(0).max(6),
    maxEvidenceItems: z.number().int().min(0).max(10),
    maxImageCandidates: z.number().int().min(0).max(8),
    maxModelCalls: z.literal(1),
  })
  .strict();

export const researchScoutAssignmentSpecV1Schema = z
  .object({
    role: researchScoutRoleSchema,
    mandate: nonEmptyText.max(2_000),
    queryAngles: z.array(shortText).min(1).max(8),
    freshness: z.enum(["current", "recent", "evergreen", "mixed"]),
    sourcePreferences: z.array(shortText).max(20).default([]),
    forbiddenOverlap: z.array(shortText).max(20).default([]),
    imageSearchRequired: z.boolean().default(false),
    budget: researchScoutBudgetSchema,
  })
  .strict();

export const researchPlanSpecV1Schema = z
  .object({
    schema: z.literal("research_plan"),
    version: z.literal(1),
    researchRunId: identifier,
    objectiveId: identifier,
    researchQuestion: nonEmptyText.max(4_000),
    freshness: z.enum(["current", "recent", "evergreen", "mixed"]),
    scoutAssignments: z.array(researchScoutAssignmentSpecV1Schema).length(5),
    budget: z
      .object({
        maxTotalSearchQueries: z.number().int().min(1).max(20),
        maxTotalFetchedSources: z.number().int().min(1).max(30),
        maxTotalImageCandidates: z.number().int().min(0).max(24),
        maxResearchModelCalls: z.number().int().min(1).max(7),
      })
      .strict(),
    sourcePreferences: z.array(shortText).max(50).default([]),
    forbiddenBehaviors: z.array(shortText).min(1).max(50),
  })
  .strict()
  .superRefine((value, ctx) => {
    const roles = value.scoutAssignments.map((assignment) => assignment.role);
    if (new Set(roles).size !== researchScoutRoleSchema.options.length) {
      ctx.addIssue({
        code: "custom",
        path: ["scoutAssignments"],
        message: "Stage 4.5 v1 requires exactly one assignment for each of the five Scout roles",
      });
    }

    const totals = value.scoutAssignments.reduce(
      (sum, assignment) => ({
        queries: sum.queries + assignment.budget.maxSearchQueries,
        sources: sum.sources + assignment.budget.maxFetchedSources,
        images: sum.images + assignment.budget.maxImageCandidates,
        modelCalls: sum.modelCalls + assignment.budget.maxModelCalls,
      }),
      { queries: 0, sources: 0, images: 0, modelCalls: 0 },
    );

    const checks: Array<[keyof typeof totals, keyof typeof value.budget, string]> = [
      ["queries", "maxTotalSearchQueries", "Scout query budgets exceed the run query budget"],
      ["sources", "maxTotalFetchedSources", "Scout source budgets exceed the run source budget"],
      ["images", "maxTotalImageCandidates", "Scout image budgets exceed the run image budget"],
      ["modelCalls", "maxResearchModelCalls", "Scout model-call budgets exceed the run model-call budget"],
    ];
    for (const [totalKey, budgetKey, message] of checks) {
      if (totals[totalKey] > value.budget[budgetKey]) {
        ctx.addIssue({ code: "custom", path: ["budget", budgetKey], message });
      }
    }
  });

export const researchEvidenceTypeSchema = z.enum([
  "market_pattern",
  "mechanic_pattern",
  "player_love",
  "player_pain",
  "saturation_signal",
  "white_space",
  "counterexample",
  "gameplay_reference_pattern",
  "visual_reference_pattern",
]);

export const researchEvidenceSpecV1Schema = z
  .object({
    schema: z.literal("research_evidence"),
    version: z.literal(1),
    evidenceId: identifier,
    researchRunId: identifier,
    scoutRole: researchScoutRoleSchema,
    evidenceType: researchEvidenceTypeSchema,
    subject: shortText,
    claim: nonEmptyText.max(4_000),
    sourceIds: z.array(identifier).min(1).max(30).refine((items) => new Set(items).size === items.length, {
      message: "sourceIds must be unique",
    }),
    confidence: z.number().min(0).max(1),
    freshnessClass: z.enum(["fresh", "recent", "evergreen", "unknown"]),
    observedAt: z.string().datetime({ offset: true }),
    tags: z.array(shortText).max(50),
    metadata: metadataSchema,
  })
  .strict();

export const researchScoutReportSpecV1Schema = z
  .object({
    schema: z.literal("research_scout_report"),
    version: z.literal(1),
    researchRunId: identifier,
    scoutRole: researchScoutRoleSchema,
    summary: nonEmptyText.max(4_000),
    sourceIds: z.array(identifier).max(30),
    evidenceIds: z.array(identifier).max(10),
    imageCandidateIds: z.array(identifier).max(8).default([]),
    queriesExecuted: z.number().int().min(0).max(4),
    coverageNotes: z.array(shortText).max(20).default([]),
    warnings: z.array(shortText).max(20).default([]),
    generatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const evidenceRefSchema = z
  .object({
    evidenceId: identifier,
    subject: shortText,
    claim: nonEmptyText.max(2_000),
    confidence: z.number().min(0).max(1),
    sourceIds: z.array(identifier).min(1).max(30),
  })
  .strict();

const contradictionSchema = z
  .object({
    claimA: nonEmptyText.max(2_000),
    claimB: nonEmptyText.max(2_000),
    interpretation: nonEmptyText.max(2_000),
    evidenceIds: z.array(identifier).min(2).max(20),
  })
  .strict();

export const evidencePackSpecV1Schema = z
  .object({
    schema: z.literal("evidence_pack"),
    version: z.literal(1),
    packId: identifier,
    researchRunId: identifier,
    objectiveId: identifier,
    marketLandscape: z.array(evidenceRefSchema).max(50),
    mechanicLandscape: z.array(evidenceRefSchema).max(50),
    playerPositiveSignals: z.array(evidenceRefSchema).max(50),
    playerPainSignals: z.array(evidenceRefSchema).max(50),
    saturatedPatterns: z.array(evidenceRefSchema).max(50),
    whiteSpaces: z.array(evidenceRefSchema).max(50),
    counterexamples: z.array(evidenceRefSchema).max(50),
    gameplayReferencePatterns: z.array(evidenceRefSchema).max(50),
    visualReferencePatterns: z.array(evidenceRefSchema).max(50),
    contradictions: z.array(contradictionSchema).max(50),
    selectedSourceIds: z.array(identifier).max(100),
    selectedImageReferenceIds: z.array(identifier).max(24),
    coverage: z.record(z.string(), z.number().int().min(0)),
    finalization: z.enum(["full", "early_finalized"]).optional(),
    generatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const externalVisualReferenceRoleSchema = z.enum([
  "gameplay_grammar",
  "environment_object",
  "composition",
  "art_direction",
  "ui_affordance",
  "negative_reference",
]);

export const externalVisualReferenceSpecV1Schema = z
  .object({
    schema: z.literal("external_visual_reference"),
    version: z.literal(1),
    referenceId: identifier,
    researchRunId: identifier,
    sourceId: identifier,
    sourceUrl: urlSchema,
    imageUrl: urlSchema,
    observedAt: z.string().datetime({ offset: true }),
    driveFileId: identifier.optional(),
    mimeType: shortText,
    width: z.number().int().positive().max(32_768),
    height: z.number().int().positive().max(32_768),
    contentSha256: sha256Schema,
    perceptualHash: nonEmptyText.max(256).optional(),
    roles: z.array(externalVisualReferenceRoleSchema).min(1).max(6),
    whyRelevant: nonEmptyText.max(2_000),
    mustNotCopy: z.array(shortText).max(30),
    trust: z.enum(["preferred", "normal", "low"]),
    metadata: metadataSchema,
  })
  .strict();

export const imageReferenceSetSpecV1Schema = z
  .object({
    schema: z.literal("image_reference_set"),
    version: z.literal(1),
    conceptId: identifier,
    momentId: identifier.optional(),
    researchRunId: identifier.optional(),
    references: z
      .array(
        z
          .object({
            referenceId: identifier,
            origin: z.enum(["gameplay_library", "external_research"]),
            role: shortText,
            priority: z.number().int().min(0).max(100),
            intendedUse: nonEmptyText.max(1_500),
            mustNotCopy: z.array(shortText).max(30),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    selectionRationale: nonEmptyText.max(2_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.references.some((reference) => reference.origin === "external_research") && !value.researchRunId) {
      ctx.addIssue({
        code: "custom",
        path: ["researchRunId"],
        message: "researchRunId is required when external research references are selected",
      });
    }
  });

export const coopGameConceptResearchContextV1Schema = z
  .object({
    researchRunId: identifier,
    evidencePackId: identifier,
    supportingEvidenceIds: z.array(identifier).min(1).max(30),
    closestAnalogs: z
      .array(
        z
          .object({
            name: shortText,
            sourceIds: z.array(identifier).min(1).max(20),
            overlap: nonEmptyText.max(1_500),
            intentionalDifference: nonEmptyText.max(1_500),
          })
          .strict(),
      )
      .max(20),
    playerSignalRationale: nonEmptyText.max(2_000),
    whiteSpaceHypothesis: nonEmptyText.max(2_000),
    researchConfidence: z.number().min(0).max(1),
    mustNotCopy: z.array(shortText).max(30),
  })
  .strict();

export type ResearchPolicySpecV1 = z.input<typeof researchPolicySpecV1Schema>;
export type ResearchScoutAssignmentSpecV1 = z.infer<typeof researchScoutAssignmentSpecV1Schema>;
export type ResearchPlanSpecV1 = z.infer<typeof researchPlanSpecV1Schema>;
export type ResearchEvidenceSpecV1 = z.infer<typeof researchEvidenceSpecV1Schema>;
export type ResearchScoutReportSpecV1 = z.infer<typeof researchScoutReportSpecV1Schema>;
export type EvidencePackSpecV1 = z.infer<typeof evidencePackSpecV1Schema>;
export type ExternalVisualReferenceSpecV1 = z.infer<typeof externalVisualReferenceSpecV1Schema>;
export type ImageReferenceSetSpecV1 = z.infer<typeof imageReferenceSetSpecV1Schema>;
export type CoopGameConceptResearchContextV1 = z.infer<typeof coopGameConceptResearchContextV1Schema>;

export const researchIntelligenceSchemasV1 = {
  researchPolicy: researchPolicySpecV1Schema,
  researchPlan: researchPlanSpecV1Schema,
  researchEvidence: researchEvidenceSpecV1Schema,
  researchScoutReport: researchScoutReportSpecV1Schema,
  evidencePack: evidencePackSpecV1Schema,
  externalVisualReference: externalVisualReferenceSpecV1Schema,
  imageReferenceSet: imageReferenceSetSpecV1Schema,
  conceptResearchContext: coopGameConceptResearchContextV1Schema,
} as const;
