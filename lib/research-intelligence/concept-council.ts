import { z } from "zod";
import { assessConceptDiversity } from "../game-discovery/diversity";
import {
  coopGameConceptSpecV1Schema,
  discoveryObjectiveSpecV1Schema,
  type CoopGameConceptSpecV1,
  type DiscoveryObjectiveSpecV1,
} from "../game-discovery/schemas";
import {
  coopGameConceptResearchContextV1Schema,
  evidencePackSpecV1Schema,
  type EvidencePackSpecV1,
} from "./schemas";

const nonEmptyText = z.string().trim().min(1);
const shortText = nonEmptyText.max(240);
const identifier = z.string().trim().min(1).max(200);

export const conceptCouncilDesignerRoleSchema = z.enum([
  "mechanics_explorer",
  "social_viral_designer",
  "buildable_systems_designer",
]);

export type ConceptCouncilDesignerRoleV1 = z.infer<typeof conceptCouncilDesignerRoleSchema>;

const conceptAnalogSchema = z
  .object({
    name: shortText,
    sourceIds: z.array(identifier).min(1).max(20),
    overlap: nonEmptyText.max(1_500),
    intentionalDifference: nonEmptyText.max(1_500),
  })
  .strict();

export const conceptHypothesisSpecV1Schema = z
  .object({
    schema: z.literal("concept_hypothesis"),
    version: z.literal(1),
    candidateId: identifier,
    researchRunId: identifier,
    evidencePackId: identifier,
    designerRole: conceptCouncilDesignerRoleSchema,
    concept: coopGameConceptSpecV1Schema,
    supportingEvidenceIds: z
      .array(identifier)
      .min(3)
      .max(8)
      .refine((items) => new Set(items).size === items.length, {
        message: "supportingEvidenceIds must be unique",
      }),
    closestAnalogs: z.array(conceptAnalogSchema).min(1).max(5),
    whatIsNew: nonEmptyText.max(2_000),
    whatMustNotCopy: z.array(shortText).min(1).max(20),
    coOpDependencyTest: z
      .object({
        mechanicallyNecessary: z.literal(true),
        rationale: nonEmptyText.max(1_500),
      })
      .strict(),
    researchConfidence: z.number().min(0).max(1),
  })
  .strict();

export const conceptDesignerOutputSpecV1Schema = z
  .object({
    schema: z.literal("concept_designer_output"),
    version: z.literal(1),
    researchRunId: identifier,
    evidencePackId: identifier,
    designerRole: conceptCouncilDesignerRoleSchema,
    candidates: z.array(conceptHypothesisSpecV1Schema).min(1).max(4),
    generatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [index, candidate] of value.candidates.entries()) {
      if (candidate.researchRunId !== value.researchRunId) {
        ctx.addIssue({
          code: "custom",
          path: ["candidates", index, "researchRunId"],
          message: "Candidate researchRunId must match designer output",
        });
      }
      if (candidate.evidencePackId !== value.evidencePackId) {
        ctx.addIssue({
          code: "custom",
          path: ["candidates", index, "evidencePackId"],
          message: "Candidate evidencePackId must match designer output",
        });
      }
      if (candidate.designerRole !== value.designerRole) {
        ctx.addIssue({
          code: "custom",
          path: ["candidates", index, "designerRole"],
          message: "Candidate designerRole must match designer output",
        });
      }
    }
  });

const curatorScoresSchema = z
  .object({
    mechanicalDistinctness: z.number().min(0).max(1),
    coOpDependency: z.number().min(0).max(1),
    researchGrounding: z.number().min(0).max(1),
    whiteSpaceValue: z.number().min(0).max(1),
    readabilityHook: z.number().min(0).max(1),
    buildability: z.number().min(0).max(1),
    visualExperimentability: z.number().min(0).max(1),
    antiCopyDistance: z.number().min(0).max(1),
  })
  .strict();

export const groundedGameCardSpecV1Schema = z
  .object({
    schema: z.literal("grounded_game_card"),
    version: z.literal(1),
    cardId: identifier,
    sourceCandidateIds: z.array(identifier).min(1).max(4),
    concept: coopGameConceptSpecV1Schema,
    researchContext: coopGameConceptResearchContextV1Schema,
    evidenceBullets: z
      .array(
        z
          .object({
            evidenceId: identifier,
            claim: nonEmptyText.max(2_000),
          })
          .strict(),
      )
      .min(3)
      .max(5),
    intentionalDifference: nonEmptyText.max(2_000),
    whatMustNotCopy: z.array(shortText).min(1).max(30),
    curatorScores: curatorScoresSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.researchContext.supportingEvidenceIds.length < 3 || value.researchContext.supportingEvidenceIds.length > 5) {
      ctx.addIssue({
        code: "custom",
        path: ["researchContext", "supportingEvidenceIds"],
        message: "Final grounded cards require 3-5 supporting evidence IDs",
      });
    }
    const bullets = new Set(value.evidenceBullets.map((item) => item.evidenceId));
    if (bullets.size !== value.evidenceBullets.length) {
      ctx.addIssue({ code: "custom", path: ["evidenceBullets"], message: "Evidence bullets must be unique" });
    }
    const contextIds = new Set(value.researchContext.supportingEvidenceIds);
    for (const [index, bullet] of value.evidenceBullets.entries()) {
      if (!contextIds.has(bullet.evidenceId)) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceBullets", index, "evidenceId"],
          message: "Every evidence bullet must be present in researchContext.supportingEvidenceIds",
        });
      }
    }
  });

export const curatedConceptBatchSpecV1Schema = z
  .object({
    schema: z.literal("curated_concept_batch"),
    version: z.literal(1),
    researchRunId: identifier,
    evidencePackId: identifier,
    rawCandidateCount: z.number().int().min(6).max(12),
    cards: z.array(groundedGameCardSpecV1Schema).length(6),
    rejectedCandidateIds: z.array(identifier).max(12),
    generatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [index, card] of value.cards.entries()) {
      if (card.researchContext.researchRunId !== value.researchRunId) {
        ctx.addIssue({
          code: "custom",
          path: ["cards", index, "researchContext", "researchRunId"],
          message: "Card researchRunId must match curated batch",
        });
      }
      if (card.researchContext.evidencePackId !== value.evidencePackId) {
        ctx.addIssue({
          code: "custom",
          path: ["cards", index, "researchContext", "evidencePackId"],
          message: "Card evidencePackId must match curated batch",
        });
      }
    }
  });

export type ConceptHypothesisSpecV1 = z.infer<typeof conceptHypothesisSpecV1Schema>;
export type ConceptDesignerOutputSpecV1 = z.infer<typeof conceptDesignerOutputSpecV1Schema>;
export type GroundedGameCardSpecV1 = z.infer<typeof groundedGameCardSpecV1Schema>;
export type CuratedConceptBatchSpecV1 = z.infer<typeof curatedConceptBatchSpecV1Schema>;

export interface ConceptCouncilDesignerExecutor {
  execute(input: {
    objective: DiscoveryObjectiveSpecV1;
    evidencePack: EvidencePackSpecV1;
    designerRole: ConceptCouncilDesignerRoleV1;
    signal?: AbortSignal;
  }): Promise<{
    output: ConceptDesignerOutputSpecV1;
    provider?: string | null;
    model?: string | null;
    usage?: Record<string, unknown>;
  }>;
}

export interface ConceptCuratorResult {
  batch: CuratedConceptBatchSpecV1;
  rejected: Array<{ candidateId: string; reasons: string[] }>;
}

function packEvidence(pack: EvidencePackSpecV1) {
  const sections = [
    pack.marketLandscape,
    pack.mechanicLandscape,
    pack.playerPositiveSignals,
    pack.playerPainSignals,
    pack.saturatedPatterns,
    pack.whiteSpaces,
    pack.counterexamples,
    pack.gameplayReferencePatterns,
    pack.visualReferencePatterns,
  ];
  const map = new Map<string, (typeof pack.marketLandscape)[number]>();
  for (const item of sections.flat()) map.set(item.evidenceId, item);
  return map;
}

function packSourceIds(pack: EvidencePackSpecV1): Set<string> {
  return new Set([
    ...pack.selectedSourceIds,
    ...[...packEvidence(pack).values()].flatMap((item) => item.sourceIds),
  ]);
}

export function validateConceptHypothesisGrounding(
  rawCandidate: ConceptHypothesisSpecV1,
  rawPack: EvidencePackSpecV1,
): ConceptHypothesisSpecV1 {
  const candidate = conceptHypothesisSpecV1Schema.parse(rawCandidate);
  const pack = evidencePackSpecV1Schema.parse(rawPack);
  if (candidate.researchRunId !== pack.researchRunId) {
    throw new Error(`CONCEPT_COUNCIL_RESEARCH_RUN_MISMATCH:${candidate.candidateId}`);
  }
  if (candidate.evidencePackId !== pack.packId) {
    throw new Error(`CONCEPT_COUNCIL_EVIDENCE_PACK_MISMATCH:${candidate.candidateId}`);
  }
  const evidence = packEvidence(pack);
  for (const evidenceId of candidate.supportingEvidenceIds) {
    if (!evidence.has(evidenceId)) {
      throw new Error(`CONCEPT_COUNCIL_ORPHAN_EVIDENCE:${candidate.candidateId}:${evidenceId}`);
    }
  }
  const sources = packSourceIds(pack);
  for (const analog of candidate.closestAnalogs) {
    for (const sourceId of analog.sourceIds) {
      if (!sources.has(sourceId)) {
        throw new Error(`CONCEPT_COUNCIL_ORPHAN_ANALOG_SOURCE:${candidate.candidateId}:${sourceId}`);
      }
    }
  }
  return candidate;
}

export function validateConceptDesignerOutput(
  rawOutput: ConceptDesignerOutputSpecV1,
  rawPack: EvidencePackSpecV1,
): ConceptDesignerOutputSpecV1 {
  const output = conceptDesignerOutputSpecV1Schema.parse(rawOutput);
  const pack = evidencePackSpecV1Schema.parse(rawPack);
  if (output.researchRunId !== pack.researchRunId || output.evidencePackId !== pack.packId) {
    throw new Error("CONCEPT_COUNCIL_DESIGNER_OUTPUT_LINEAGE_MISMATCH");
  }
  output.candidates.forEach((candidate) => validateConceptHypothesisGrounding(candidate, pack));
  return output;
}

function buildabilityScore(concept: CoopGameConceptSpecV1): number {
  const weights = { low: 1, medium: 0.75, high: 0.35 } as const;
  const ai = concept.buildability.npcAiDependency === "none" ? 1 : concept.buildability.npcAiDependency === "light" ? 0.75 : 0.3;
  return Number(
    (
      (weights[concept.buildability.networking] +
        weights[concept.buildability.physics] +
        weights[concept.buildability.contentBurden] +
        weights[concept.buildability.systemicInteractions] +
        ai) /
      5
    ).toFixed(4),
  );
}

function buildGameCard(input: {
  candidate: ConceptHypothesisSpecV1;
  pack: EvidencePackSpecV1;
  axisDistance: number;
  whiteSpaceEvidenceIds: Set<string>;
}): GroundedGameCardSpecV1 {
  const evidence = packEvidence(input.pack);
  const support = input.candidate.supportingEvidenceIds.slice(0, 5);
  const grounding = Math.min(1, support.reduce((sum, id) => sum + (evidence.get(id)?.confidence ?? 0), 0) / support.length);
  const whiteSpaceHits = support.filter((id) => input.whiteSpaceEvidenceIds.has(id)).length;
  const researchContext = {
    researchRunId: input.candidate.researchRunId,
    evidencePackId: input.candidate.evidencePackId,
    supportingEvidenceIds: support,
    closestAnalogs: input.candidate.closestAnalogs,
    playerSignalRationale: `Grounded in ${support.length} selected Research Evidence items; downstream evaluation must still test player appeal rather than treating research as proof.`,
    whiteSpaceHypothesis: input.candidate.whatIsNew,
    researchConfidence: Number(Math.min(1, (input.candidate.researchConfidence + grounding) / 2).toFixed(4)),
    mustNotCopy: input.candidate.whatMustNotCopy,
  };
  return groundedGameCardSpecV1Schema.parse({
    schema: "grounded_game_card",
    version: 1,
    cardId: `card-${input.candidate.candidateId}`,
    sourceCandidateIds: [input.candidate.candidateId],
    concept: input.candidate.concept,
    researchContext,
    evidenceBullets: support.map((id) => ({ evidenceId: id, claim: evidence.get(id)!.claim })),
    intentionalDifference: input.candidate.whatIsNew,
    whatMustNotCopy: input.candidate.whatMustNotCopy,
    curatorScores: {
      mechanicalDistinctness: Number(Math.min(1, 0.4 + input.axisDistance / 10).toFixed(4)),
      coOpDependency: 1,
      researchGrounding: Number(grounding.toFixed(4)),
      whiteSpaceValue: Number(Math.min(1, 0.55 + whiteSpaceHits * 0.12).toFixed(4)),
      readabilityHook: 0.82,
      buildability: buildabilityScore(input.candidate.concept),
      visualExperimentability: 0.82,
      antiCopyDistance: Number(Math.min(1, 0.45 + input.axisDistance / 9).toFixed(4)),
    },
  });
}

export function curateConceptCandidates(input: {
  candidates: ConceptHypothesisSpecV1[];
  evidencePack: EvidencePackSpecV1;
  history?: CoopGameConceptSpecV1[];
  generatedAt?: string;
}): ConceptCuratorResult {
  const pack = evidencePackSpecV1Schema.parse(input.evidencePack);
  const candidates = input.candidates.map((candidate) => validateConceptHypothesisGrounding(candidate, pack));
  if (candidates.length < 6 || candidates.length > 12) {
    throw new Error(`CONCEPT_COUNCIL_RAW_CANDIDATE_COUNT_INVALID:${candidates.length}`);
  }
  if (new Set(candidates.map((candidate) => candidate.candidateId)).size !== candidates.length) {
    throw new Error("CONCEPT_COUNCIL_DUPLICATE_CANDIDATE_ID");
  }

  const whiteSpaceEvidenceIds = new Set(pack.whiteSpaces.map((item) => item.evidenceId));
  const ranked = [...candidates].sort((a, b) => {
    const aWhite = a.supportingEvidenceIds.some((id) => whiteSpaceEvidenceIds.has(id)) ? 1 : 0;
    const bWhite = b.supportingEvidenceIds.some((id) => whiteSpaceEvidenceIds.has(id)) ? 1 : 0;
    return bWhite - aWhite || b.researchConfidence - a.researchConfidence || a.candidateId.localeCompare(b.candidateId);
  });

  const history = (input.history ?? []).map((item) => coopGameConceptSpecV1Schema.parse(item));
  const selected: Array<{ candidate: ConceptHypothesisSpecV1; axisDistance: number }> = [];
  const rejected: Array<{ candidateId: string; reasons: string[] }> = [];

  for (const candidate of ranked) {
    const references = [...history, ...selected.map((item) => item.candidate.concept)];
    const assessment = assessConceptDiversity(candidate.concept, references);
    if (assessment.decision === "replace") {
      rejected.push({ candidateId: candidate.candidateId, reasons: assessment.rejectionReasons });
      continue;
    }
    selected.push({
      candidate,
      axisDistance: assessment.nearest?.axisDistance ?? 6,
    });
    if (selected.length === 6) break;
  }

  if (selected.length !== 6) {
    throw new Error(`CONCEPT_COUNCIL_INSUFFICIENT_DIVERSE_CANDIDATES:${selected.length}`);
  }

  const selectedIds = new Set(selected.map((item) => item.candidate.candidateId));
  for (const candidate of candidates) {
    if (!selectedIds.has(candidate.candidateId) && !rejected.some((item) => item.candidateId === candidate.candidateId)) {
      rejected.push({ candidateId: candidate.candidateId, reasons: ["curator_capacity_limit"] });
    }
  }

  const batch = curatedConceptBatchSpecV1Schema.parse({
    schema: "curated_concept_batch",
    version: 1,
    researchRunId: pack.researchRunId,
    evidencePackId: pack.packId,
    rawCandidateCount: candidates.length,
    cards: selected.map((item) =>
      buildGameCard({ candidate: item.candidate, pack, axisDistance: item.axisDistance, whiteSpaceEvidenceIds }),
    ),
    rejectedCandidateIds: rejected.map((item) => item.candidateId),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  });

  return { batch, rejected };
}

type MockTemplate = {
  core: string;
  dependency: string;
  social: string;
  tempo: string;
  camera: string;
  failure: string;
  interaction: string;
  setting: string;
  networking: "low" | "medium" | "high";
  physics: "low" | "medium" | "high";
  content: "low" | "medium" | "high";
};

const MOCK_TEMPLATES: Record<ConceptCouncilDesignerRoleV1, MockTemplate[]> = {
  mechanics_explorer: [
    { core: "Players continuously transfer mass across one unstable shared machine to steer it through hazards.", dependency: "One player can add momentum while another must remove or redirect it; either player alone loses control of the shared machine.", social: "blame", tempo: "escalating chaos", camera: "third-person action", failure: "cascading disaster", interaction: "shared object", setting: "A mobile salvage rig crossing a collapsing industrial moon.", networking: "medium", physics: "medium", content: "low" },
    { core: "One player sees safe geometry while the other physically operates blind modular crane limbs from local instrument feedback.", dependency: "The navigator owns spatial truth and the operator owns movement authority, so neither role can progress alone.", social: "hidden information", tempo: "precision", camera: "first-person tools", failure: "delayed reveal", interaction: "information asymmetry", setting: "A fogbound orbital scrapyard.", networking: "low", physics: "medium", content: "low" },
    { core: "Players alternate charging and venting a shared pressure body whose rhythm controls locomotion and tools.", dependency: "Every useful action consumes pressure created by another player on a different timing phase.", social: "panic", tempo: "chase", camera: "top-down systems", failure: "one-player mistake hurting all", interaction: "timing", setting: "A living pressure-suit convoy inside a storm engine.", networking: "medium", physics: "low", content: "medium" },
    { core: "Players flip complementary magnetic polarities to climb by creating temporary anchors for each other.", dependency: "A player cannot create an anchor for their own polarity; forward movement requires alternating partner-created holds.", social: "rescue", tempo: "survival", camera: "close physical comedy", failure: "recovery challenge", interaction: "physics coordination", setting: "A vertical magnetic ruin above a gas giant.", networking: "medium", physics: "medium", content: "medium" },
  ],
  social_viral_designer: [
    { core: "Two players share one disguise creature: one controls posture and locomotion while the other controls face, voice, and gestures under suspicion.", dependency: "Passing social checks requires body and expression systems to agree in real time, and each player owns only half.", social: "trust", tempo: "calm coordination", camera: "close physical comedy", failure: "instant funny fail", interaction: "shared body/system", setting: "A surreal customs terminal for impossible creatures.", networking: "low", physics: "low", content: "medium" },
    { core: "Players negotiate who temporarily carries dangerous shared resources while public commitments lock future actions.", dependency: "Resources cannot be split, and every transfer changes what the other player is able to do next.", social: "negotiation", tempo: "tactical", camera: "top-down systems", failure: "delayed reveal", interaction: "resource coupling", setting: "A tiny convoy crossing a cursed trade route.", networking: "low", physics: "low", content: "low" },
    { core: "Players receive mirrored control verbs whose meanings periodically swap, forcing them to verbally re-map each other's actions while moving one shared platform.", dependency: "Each player controls half of the platform functions and the mapping change cannot be solved by one person acting alone.", social: "accidental sabotage", tempo: "escalating chaos", camera: "vehicle/creature control", failure: "instant funny fail", interaction: "communication constraints", setting: "A malfunctioning parade float escaping an automated city.", networking: "medium", physics: "low", content: "low" },
    { core: "Players courier one fragile shared inventory where rescuing a partner requires deliberately exposing their own protected slot.", dependency: "Only the partner can open the rescue path, and doing so puts their own critical cargo at risk.", social: "sacrifice", tempo: "chase", camera: "third-person action", failure: "recovery challenge", interaction: "role asymmetry", setting: "A storm evacuation across moving rooftops.", networking: "medium", physics: "low", content: "medium" },
  ],
  buildable_systems_designer: [
    { core: "One player aims a narrow light that reveals traversal rules while the other moves through darkness using only the revealed temporary path.", dependency: "The mover cannot reveal rules and the spotter cannot traverse them, so progress alternates between complementary jobs.", social: "trust", tempo: "precision", camera: "first-person tools", failure: "one-player mistake hurting all", interaction: "information asymmetry", setting: "A compact maintenance maze with reactive shadows.", networking: "low", physics: "low", content: "low" },
    { core: "Players route one conveyor of multi-use parts by making simultaneous local switches that create incompatible downstream consequences.", dependency: "Every junction needs two independent switch decisions and no player can see or operate the full route.", social: "blame", tempo: "logistics", camera: "top-down systems", failure: "cascading disaster", interaction: "shared object", setting: "A pocket-sized emergency repair factory.", networking: "low", physics: "low", content: "low" },
    { core: "Players share one battery polarity: one can energize movement systems while the other can energize doors and tools, never at the same instant.", dependency: "Advancement requires deliberate hand-offs because the same shared charge cannot power both players' required systems simultaneously.", social: "synchronized success", tempo: "tactical", camera: "third-person action", failure: "recovery challenge", interaction: "resource coupling", setting: "A stranded survey station during a power collapse.", networking: "low", physics: "low", content: "low" },
    { core: "Players fold opposite sides of one shared map to physically change which rooms touch, then traverse the topology they jointly created.", dependency: "Each player owns different fold axes; valid routes require two-axis combinations that neither can create alone.", social: "negotiation", tempo: "construction", camera: "isometric systems", failure: "delayed reveal", interaction: "shared body/system", setting: "A small impossible archive built from folding rooms.", networking: "low", physics: "low", content: "medium" },
  ],
};

function mockConcept(role: ConceptCouncilDesignerRoleV1, index: number, template: MockTemplate): CoopGameConceptSpecV1 {
  const conceptId = `council-${role}-${index + 1}`;
  return coopGameConceptSpecV1Schema.parse({
    schema: "coop_game_concept",
    version: 1,
    conceptId,
    oneSentencePitch: `${template.core} Friends survive by coordinating a dependency neither player can bypass.`,
    coreMechanic: template.core,
    coopDependency: template.dependency,
    playerRoles: [
      { role: "Player A", responsibility: "Own one necessary half of the shared mechanic." },
      { role: "Player B", responsibility: "Own the complementary half that makes Player A's action useful." },
    ],
    playerCount: { min: 2, max: 4, ideal: 2 },
    interactionModel: [template.interaction, template.social],
    failureMode: template.failure,
    socialMoment: template.social,
    gameplayHook: `The shared dependency is readable immediately: ${template.dependency}`,
    spectacle: `A visible ${template.failure} exposes who depended on whom.`,
    setting: template.setting,
    artDirection: "Readable stylized functional shapes; mechanics remain clearer than decoration.",
    camera: template.camera,
    readability: "Distinct player responsibilities and the shared state stay visible in a three-second gameplay beat.",
    noveltyAxes: [
      { axis: "dependency_type", choice: template.interaction, whyDifferent: "The dependency changes who can cause useful state transitions." },
      { axis: "social_tension", choice: template.social, whyDifferent: "The social consequence is produced directly by the mechanic." },
      { axis: "tempo", choice: template.tempo, whyDifferent: "The tempo changes the coordination burden." },
      { axis: "camera_scale", choice: template.camera, whyDifferent: "The camera is chosen to make the dependency legible." },
      { axis: "failure_signature", choice: template.failure, whyDifferent: "Failure visibly propagates through the shared system." },
      { axis: "buildability_shape", choice: `${template.networking}|${template.physics}|${template.content}`, whyDifferent: "The prototype risk profile is intentionally bounded." },
    ],
    buildability: {
      networking: template.networking,
      physics: template.physics,
      contentBurden: template.content,
      npcAiDependency: "none",
      systemicInteractions: "medium",
      mainRisks: ["The dependency must remain understandable under real playtest pressure."],
      mvpRead: "Prototype one room, one shared mechanic, one success beat, and one failure beat before adding content.",
    },
    referenceInfluences: [],
  });
}

export class MockConceptCouncilDesigner implements ConceptCouncilDesignerExecutor {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async execute(input: {
    objective: DiscoveryObjectiveSpecV1;
    evidencePack: EvidencePackSpecV1;
    designerRole: ConceptCouncilDesignerRoleV1;
  }) {
    discoveryObjectiveSpecV1Schema.parse(input.objective);
    const pack = evidencePackSpecV1Schema.parse(input.evidencePack);
    const evidence = [...packEvidence(pack).values()];
    if (evidence.length < 3) throw new Error("CONCEPT_COUNCIL_REQUIRES_THREE_EVIDENCE_ITEMS");
    const templates = MOCK_TEMPLATES[input.designerRole];
    const candidates = templates.map((template, index) => {
      const start = index % evidence.length;
      const selected = [evidence[start]!, evidence[(start + 1) % evidence.length]!, evidence[(start + 2) % evidence.length]!];
      const sources = [...new Set(selected.flatMap((item) => item.sourceIds))];
      return conceptHypothesisSpecV1Schema.parse({
        schema: "concept_hypothesis",
        version: 1,
        candidateId: `candidate-${input.designerRole}-${index + 1}`,
        researchRunId: pack.researchRunId,
        evidencePackId: pack.packId,
        designerRole: input.designerRole,
        concept: mockConcept(input.designerRole, index, template),
        supportingEvidenceIds: selected.map((item) => item.evidenceId),
        closestAnalogs: [
          {
            name: `Evidence-backed analog ${index + 1}`,
            sourceIds: sources.slice(0, Math.max(1, Math.min(3, sources.length))),
            overlap: "Shares one observed market/mechanic pattern but is not treated as a design template.",
            intentionalDifference: `Uses ${template.interaction} with ${template.social} as a different mechanical dependency and failure structure.`,
          },
        ],
        whatIsNew: `Combines ${template.interaction}, ${template.social}, ${template.tempo}, and ${template.failure} into one mechanically necessary co-op loop rather than changing only setting or art.`,
        whatMustNotCopy: ["Do not copy an analog's characters, level layout, visual identity, or exact interaction sequence."],
        coOpDependencyTest: { mechanicallyNecessary: true, rationale: template.dependency },
        researchConfidence: 0.78 + index * 0.03,
      });
    });
    const output = validateConceptDesignerOutput(
      {
        schema: "concept_designer_output",
        version: 1,
        researchRunId: pack.researchRunId,
        evidencePackId: pack.packId,
        designerRole: input.designerRole,
        candidates,
        generatedAt: this.now().toISOString(),
      },
      pack,
    );
    return { output, provider: "mock", model: `deterministic-${input.designerRole}`, usage: { model_calls: 1 } };
  }
}
