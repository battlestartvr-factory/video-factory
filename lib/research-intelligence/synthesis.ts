import { randomUUID } from "node:crypto";
import {
  evidencePackSpecV1Schema,
  researchEvidenceSpecV1Schema,
  researchScoutReportSpecV1Schema,
  researchScoutRoleSchema,
  type EvidencePackSpecV1,
  type ResearchEvidenceSpecV1,
  type ResearchScoutReportSpecV1,
  type ResearchScoutRoleV1,
} from "./schemas";
import { researchSha256 } from "./evidence-bundle";

export interface ResearchScoutSynthesisStatusV1 {
  scoutRole: ResearchScoutRoleV1;
  status: string;
  report: ResearchScoutReportSpecV1 | null;
}

export interface ResearchSynthesisInputV1 {
  researchRunId: string;
  objectiveId: string;
  scoutStatuses: ResearchScoutSynthesisStatusV1[];
  evidence: ResearchEvidenceSpecV1[];
  knownSourceIds: string[];
  knownImageReferenceIds: string[];
  activePack: EvidencePackSpecV1 | null;
}

export interface ResearchSynthesisExecutionResultV1 {
  pack: EvidencePackSpecV1;
  provider?: string;
  model?: string;
  usage?: Record<string, unknown>;
  rawResponse?: Record<string, unknown>;
}

export interface ResearchSynthesizerExecutor {
  synthesize(input: {
    synthesisInput: ResearchSynthesisInputV1;
    signal?: AbortSignal;
  }): Promise<ResearchSynthesisExecutionResultV1>;
}

export interface ResearchSynthesisRepository {
  loadSynthesisInput(researchRunId: string): Promise<ResearchSynthesisInputV1>;
  getFinalization?(researchRunId: string): Promise<"full" | "early_finalized">;
  persistEvidencePack(input: {
    researchRunId: string;
    inputHash: string;
    pack: EvidencePackSpecV1;
    metadata?: Record<string, unknown>;
  }): Promise<{ duplicate: boolean; pack: EvidencePackSpecV1 }>;
}

const PACK_SECTIONS = [
  "marketLandscape",
  "mechanicLandscape",
  "playerPositiveSignals",
  "playerPainSignals",
  "saturatedPatterns",
  "whiteSpaces",
  "counterexamples",
  "gameplayReferencePatterns",
  "visualReferencePatterns",
] as const;

type PackSection = (typeof PACK_SECTIONS)[number];
type EvidenceRef = EvidencePackSpecV1["marketLandscape"][number];
type PackSections = Record<PackSection, EvidenceRef[]>;

function emptyPackSections(): PackSections {
  return {
    marketLandscape: [],
    mechanicLandscape: [],
    playerPositiveSignals: [],
    playerPainSignals: [],
    saturatedPatterns: [],
    whiteSpaces: [],
    counterexamples: [],
    gameplayReferencePatterns: [],
    visualReferencePatterns: [],
  };
}

function normalizeInput(input: ResearchSynthesisInputV1): ResearchSynthesisInputV1 {
  const roles = new Set(researchScoutRoleSchema.options);
  const statuses = input.scoutStatuses.map((status) => {
    if (!roles.has(status.scoutRole)) throw new Error(`Unknown Scout role: ${status.scoutRole}`);
    return {
      scoutRole: status.scoutRole,
      status: status.status,
      report: status.report ? researchScoutReportSpecV1Schema.parse(status.report) : null,
    };
  });
  const evidence = input.evidence.map((item) => researchEvidenceSpecV1Schema.parse(item));
  for (const item of evidence) {
    if (item.researchRunId !== input.researchRunId) {
      throw new Error(`Evidence ${item.evidenceId} belongs to another research run`);
    }
  }
  return {
    ...input,
    scoutStatuses: statuses,
    evidence,
    knownSourceIds: [...new Set(input.knownSourceIds)].sort(),
    knownImageReferenceIds: [...new Set(input.knownImageReferenceIds)].sort(),
    activePack: input.activePack ? evidencePackSpecV1Schema.parse(input.activePack) : null,
  };
}

export function researchSynthesisInputHash(input: ResearchSynthesisInputV1): string {
  const normalized = normalizeInput(input);
  return researchSha256({
    researchRunId: normalized.researchRunId,
    objectiveId: normalized.objectiveId,
    scoutStatuses: normalized.scoutStatuses
      .map((item) => ({ role: item.scoutRole, status: item.status, report: item.report }))
      .sort((a, b) => a.role.localeCompare(b.role)),
    evidence: normalized.evidence
      .map((item) => ({
        ...item,
        sourceIds: [...item.sourceIds].sort(),
        tags: [...item.tags].sort(),
      }))
      .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)),
    knownSourceIds: normalized.knownSourceIds,
    knownImageReferenceIds: normalized.knownImageReferenceIds,
  });
}

export function validateEvidencePackReferences(
  rawPack: EvidencePackSpecV1,
  input: ResearchSynthesisInputV1,
): EvidencePackSpecV1 {
  const normalizedInput = normalizeInput(input);
  const pack = evidencePackSpecV1Schema.parse(rawPack);
  if (pack.researchRunId !== normalizedInput.researchRunId) {
    throw new Error("Evidence Pack researchRunId does not match synthesis input");
  }
  if (pack.objectiveId !== normalizedInput.objectiveId) {
    throw new Error("Evidence Pack objectiveId does not match synthesis input");
  }

  const evidenceById = new Map(normalizedInput.evidence.map((item) => [item.evidenceId, item]));
  const knownSourceIds = new Set(normalizedInput.knownSourceIds);
  const knownImageIds = new Set(normalizedInput.knownImageReferenceIds);

  for (const section of PACK_SECTIONS) {
    for (const reference of pack[section]) {
      const evidence = evidenceById.get(reference.evidenceId);
      if (!evidence) {
        throw new Error(`Evidence Pack contains orphan evidence ID ${reference.evidenceId} in ${section}`);
      }
      const evidenceSourceIds = new Set(evidence.sourceIds);
      for (const sourceId of reference.sourceIds) {
        if (!knownSourceIds.has(sourceId) || !evidenceSourceIds.has(sourceId)) {
          throw new Error(
            `Evidence Pack contains orphan source ID ${sourceId} for evidence ${reference.evidenceId}`,
          );
        }
      }
    }
  }

  for (const contradiction of pack.contradictions) {
    for (const evidenceId of contradiction.evidenceIds) {
      if (!evidenceById.has(evidenceId)) {
        throw new Error(`Evidence Pack contradiction references orphan evidence ID ${evidenceId}`);
      }
    }
  }

  for (const sourceId of pack.selectedSourceIds) {
    if (!knownSourceIds.has(sourceId)) {
      throw new Error(`Evidence Pack selectedSourceIds contains orphan source ID ${sourceId}`);
    }
  }
  for (const imageId of pack.selectedImageReferenceIds) {
    if (!knownImageIds.has(imageId)) {
      throw new Error(`Evidence Pack selectedImageReferenceIds contains orphan image ID ${imageId}`);
    }
  }
  return pack;
}

export class ResearchSynthesisService {
  constructor(
    private readonly repository: ResearchSynthesisRepository,
    private readonly executor: ResearchSynthesizerExecutor,
  ) {}

  async run(input: {
    researchRunId: string;
    signal?: AbortSignal;
    finalization?: "full" | "early_finalized";
  }): Promise<{
    pack: EvidencePackSpecV1;
    reusedFromPersistence: boolean;
    inputHash: string;
  }> {
    const synthesisInput = normalizeInput(await this.repository.loadSynthesisInput(input.researchRunId));
    if (synthesisInput.researchRunId !== input.researchRunId) {
      throw new Error("Research synthesis repository returned the wrong research run");
    }
    const inputHash = researchSynthesisInputHash({ ...synthesisInput, activePack: null });

    if (synthesisInput.activePack) {
      return {
        pack: validateEvidencePackReferences(synthesisInput.activePack, synthesisInput),
        reusedFromPersistence: true,
        inputHash,
      };
    }

    const finalization = input.finalization ?? (
      this.repository.getFinalization
        ? await this.repository.getFinalization(input.researchRunId)
        : "full"
    );
    const execution = await this.executor.synthesize({ synthesisInput, signal: input.signal });
    const markedPack = evidencePackSpecV1Schema.parse({
      ...execution.pack,
      finalization,
    });
    const pack = validateEvidencePackReferences(markedPack, synthesisInput);
    const persisted = await this.repository.persistEvidencePack({
      researchRunId: input.researchRunId,
      inputHash,
      pack,
      metadata: {
        provider: execution.provider ?? null,
        model: execution.model ?? null,
        usage: execution.usage ?? {},
        finalization: pack.finalization ?? "full",
        raw_response_persisted_separately: execution.rawResponse !== undefined,
      },
    });
    return { pack: persisted.pack, reusedFromPersistence: persisted.duplicate, inputHash };
  }
}

function normalizedClaim(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function freshnessMultiplier(value: ResearchEvidenceSpecV1["freshnessClass"]): number {
  switch (value) {
    case "fresh":
      return 1;
    case "recent":
      return 0.9;
    case "evergreen":
      return 0.85;
    default:
      return 0.65;
  }
}

function evidenceRef(item: ResearchEvidenceSpecV1, conflicted: boolean): EvidenceRef {
  const conflictMultiplier = conflicted ? 0.8 : 1;
  return {
    evidenceId: item.evidenceId,
    subject: item.subject,
    claim: item.claim,
    confidence: Math.max(
      0,
      Math.min(1, Number((item.confidence * freshnessMultiplier(item.freshnessClass) * conflictMultiplier).toFixed(4))),
    ),
    sourceIds: [...new Set(item.sourceIds)].sort(),
  };
}

function sectionForEvidenceType(type: ResearchEvidenceSpecV1["evidenceType"]): PackSection {
  switch (type) {
    case "market_pattern":
      return "marketLandscape";
    case "mechanic_pattern":
      return "mechanicLandscape";
    case "player_love":
      return "playerPositiveSignals";
    case "player_pain":
      return "playerPainSignals";
    case "saturation_signal":
      return "saturatedPatterns";
    case "white_space":
      return "whiteSpaces";
    case "counterexample":
      return "counterexamples";
    case "gameplay_reference_pattern":
      return "gameplayReferencePatterns";
    case "visual_reference_pattern":
      return "visualReferencePatterns";
  }
}

/**
 * Deterministic PR4 acceptance executor. Production can replace this with one stronger
 * synthesis model without changing the EvidencePack contract or persistence boundary.
 * It only consumes typed reports/evidence and never raw fetched pages.
 */
export class MockResearchSynthesizer implements ResearchSynthesizerExecutor {
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly idFactory: () => string = () => randomUUID(),
  ) {}

  async synthesize(input: {
    synthesisInput: ResearchSynthesisInputV1;
  }): Promise<ResearchSynthesisExecutionResultV1> {
    const synthesisInput = normalizeInput(input.synthesisInput);
    const bySubject = new Map<string, ResearchEvidenceSpecV1[]>();
    for (const item of synthesisInput.evidence) {
      const key = normalizedClaim(item.subject);
      bySubject.set(key, [...(bySubject.get(key) ?? []), item]);
    }

    const contradictions: EvidencePackSpecV1["contradictions"] = [];
    const conflicted = new Set<string>();
    for (const group of bySubject.values()) {
      const positive = group.filter((item) => item.evidenceType !== "counterexample");
      const negative = group.filter((item) => item.evidenceType === "counterexample");
      if (!positive.length || !negative.length) continue;
      const a = [...positive].sort((left, right) => right.confidence - left.confidence)[0]!;
      const b = [...negative].sort((left, right) => right.confidence - left.confidence)[0]!;
      conflicted.add(a.evidenceId);
      conflicted.add(b.evidenceId);
      contradictions.push({
        claimA: a.claim,
        claimB: b.claim,
        interpretation: "Conflicting source-backed observations require downstream caution; neither side is treated as final truth.",
        evidenceIds: [a.evidenceId, b.evidenceId],
      });
    }

    const sections = emptyPackSections();
    const seenClaims = new Set<string>();
    const sorted = [...synthesisInput.evidence].sort(
      (a, b) => b.confidence - a.confidence || a.evidenceId.localeCompare(b.evidenceId),
    );
    for (const item of sorted) {
      const claimKey = `${item.evidenceType}:${normalizedClaim(item.subject)}:${normalizedClaim(item.claim)}`;
      if (seenClaims.has(claimKey)) continue;
      seenClaims.add(claimKey);
      const section = sectionForEvidenceType(item.evidenceType);
      sections[section].push(evidenceRef(item, conflicted.has(item.evidenceId)));
    }

    const allRefs = PACK_SECTIONS.flatMap((section) => sections[section]);
    const selectedSourceIds = [...new Set(allRefs.flatMap((reference) => reference.sourceIds))]
      .filter((id) => synthesisInput.knownSourceIds.includes(id))
      .sort();
    const coverage = Object.fromEntries(
      researchScoutRoleSchema.options.map((role) => [
        role,
        synthesisInput.evidence.filter((item) => item.scoutRole === role).length,
      ]),
    );
    coverage.total_evidence = synthesisInput.evidence.length;
    coverage.missing_scout_reports = synthesisInput.scoutStatuses.filter((item) => !item.report).length;

    const pack: EvidencePackSpecV1 = {
      schema: "evidence_pack",
      version: 1,
      packId: this.idFactory(),
      researchRunId: synthesisInput.researchRunId,
      objectiveId: synthesisInput.objectiveId,
      ...sections,
      contradictions,
      selectedSourceIds,
      selectedImageReferenceIds: [],
      coverage,
      generatedAt: this.now().toISOString(),
    };
    return { pack: evidencePackSpecV1Schema.parse(pack), provider: "mock", model: "deterministic-pr4" };
  }
}
