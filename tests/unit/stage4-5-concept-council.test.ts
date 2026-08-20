import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MockConceptCouncilDesigner,
  conceptDesignerOutputSpecV1Schema,
  curateConceptCandidates,
  validateConceptHypothesisGrounding,
  type ConceptCouncilDesignerRoleV1,
  type ConceptDesignerOutputSpecV1,
  type ConceptHypothesisSpecV1,
} from "@/lib/research-intelligence/concept-council";
import type { ConceptCouncilMemberJobContext } from "@/lib/research-intelligence/concept-council-runtime";
import type { EvidencePackSpecV1 } from "@/lib/research-intelligence/schemas";
import type { DiscoveryObjectiveSpecV1 } from "@/lib/game-discovery/schemas";
import { conceptCouncilMemberV1 } from "@/worker/workflows/concept-council-member-v1";
import type { WorkflowServices } from "@/worker/workflows/types";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260820134500_stage4_5_concept_council.sql"),
  "utf8",
);
const registry = readFileSync(join(process.cwd(), "worker/workflows/registry.ts"), "utf8");

const roles: ConceptCouncilDesignerRoleV1[] = [
  "mechanics_explorer",
  "social_viral_designer",
  "buildable_systems_designer",
];

function objective(): DiscoveryObjectiveSpecV1 {
  return {
    schema: "discovery_objective",
    version: 1,
    objectiveId: "objective-1",
    title: "Find a new readable friends co-op game",
    searchIntent: "Explore mechanically necessary two-to-four-player co-op concepts grounded in current external evidence.",
    playerCount: { min: 2, max: 4 },
    platform: "pc_steam",
    desiredNovelty: "explore",
    conceptCount: 6,
    maxConceptsToPrototype: 2,
    constraints: { networkingComplexity: "medium", contentBurden: "medium", npcAiDependency: "avoid" },
  };
}

function evidenceRef(index: number, type: "mechanic" | "white" | "player") {
  return {
    evidenceId: `e-${index}`,
    subject: `${type}-subject-${index}`,
    claim: `${type} evidence claim ${index}`,
    confidence: Math.max(0.55, 0.95 - index * 0.03),
    sourceIds: [`s-${(index % 4) + 1}`],
  };
}

function evidencePack(): EvidencePackSpecV1 {
  return {
    schema: "evidence_pack",
    version: 1,
    packId: "pack-1",
    researchRunId: "research-run-1",
    objectiveId: "objective-1",
    marketLandscape: [evidenceRef(1, "mechanic")],
    mechanicLandscape: [evidenceRef(2, "mechanic"), evidenceRef(3, "mechanic")],
    playerPositiveSignals: [evidenceRef(4, "player"), evidenceRef(5, "player")],
    playerPainSignals: [evidenceRef(6, "player")],
    saturatedPatterns: [evidenceRef(7, "mechanic")],
    whiteSpaces: [evidenceRef(8, "white"), evidenceRef(9, "white"), evidenceRef(10, "white")],
    counterexamples: [evidenceRef(11, "player")],
    gameplayReferencePatterns: [evidenceRef(12, "mechanic")],
    visualReferencePatterns: [],
    contradictions: [],
    selectedSourceIds: ["s-1", "s-2", "s-3", "s-4"],
    selectedImageReferenceIds: [],
    coverage: { total_evidence: 12 },
    generatedAt: "2026-08-20T12:00:00.000Z",
  };
}

async function allDesignerOutputs(): Promise<ConceptDesignerOutputSpecV1[]> {
  const designer = new MockConceptCouncilDesigner(() => new Date("2026-08-20T12:05:00.000Z"));
  const pack = evidencePack();
  return Promise.all(
    roles.map(async (designerRole) => {
      const result = await designer.execute({ objective: objective(), evidencePack: pack, designerRole });
      return conceptDesignerOutputSpecV1Schema.parse(result.output);
    }),
  );
}

describe("Stage 4.5 PR5 durable Concept Council DB contract", () => {
  it("fans out exactly three canonical designers onto the existing research queue", () => {
    expect(migration).toContain("'mechanics_explorer','social_viral_designer','buildable_systems_designer'");
    expect(migration).toContain("'concept_council_member'");
    expect(migration).toContain("'research_orchestrator_v1'");
    expect(migration).toContain("PRIMARY KEY (run_id, designer_role)");
    expect(migration).toContain("Concept Designer must persist between one and four candidates");
  });

  it("validates candidate Evidence Pack provenance and final 3-5 evidence bullets in SQL", () => {
    expect(migration).toContain("research_pack_evidence");
    expect(migration).toContain("Concept Hypothesis contains orphan Evidence Pack evidence ID");
    expect(migration).toContain("Grounded Game Card contains orphan Evidence Pack evidence ID");
    expect(migration).toContain("Grounded Game Card requires 3-5 research evidence bullets");
    expect(migration).toContain("Concept Curator must persist exactly six grounded Game Cards");
  });

  it("keeps Stage 4 v1 registered while adding the independent council member workflow", () => {
    expect(registry).toContain('["concept_council_member@1", conceptCouncilMemberV1]');
    expect(registry).toContain('["game_discovery_batch@1", gameDiscoveryBatchStage4InspectedV1]');
  });
});

describe("Stage 4.5 PR5 Concept Council acceptance", () => {
  it("runs three independent designers with four evidence-linked hypotheses each", async () => {
    const outputs = await allDesignerOutputs();
    expect(outputs).toHaveLength(3);
    expect(new Set(outputs.map((output) => output.designerRole))).toEqual(new Set(roles));
    expect(outputs.every((output) => output.candidates.length === 4)).toBe(true);
    expect(outputs.flatMap((output) => output.candidates)).toHaveLength(12);
    for (const candidate of outputs.flatMap((output) => output.candidates)) {
      expect(candidate.supportingEvidenceIds.length).toBeGreaterThanOrEqual(3);
      expect(candidate.whatIsNew.length).toBeGreaterThan(0);
      expect(candidate.whatMustNotCopy.length).toBeGreaterThan(0);
      expect(candidate.coOpDependencyTest.mechanicallyNecessary).toBe(true);
    }
  });

  it("curates 12 raw candidates to exactly six grounded, mechanically diverse Game Cards", async () => {
    const outputs = await allDesignerOutputs();
    const candidates = outputs.flatMap((output) => output.candidates);
    const result = curateConceptCandidates({
      candidates,
      evidencePack: evidencePack(),
      generatedAt: "2026-08-20T12:10:00.000Z",
    });

    expect(result.batch.rawCandidateCount).toBe(12);
    expect(result.batch.cards).toHaveLength(6);
    expect(new Set(result.batch.cards.map((card) => card.concept.conceptId)).size).toBe(6);
    expect(result.batch.rejectedCandidateIds).toHaveLength(6);
    for (const card of result.batch.cards) {
      expect(card.evidenceBullets.length).toBeGreaterThanOrEqual(3);
      expect(card.evidenceBullets.length).toBeLessThanOrEqual(5);
      expect(card.researchContext.closestAnalogs.length).toBeGreaterThan(0);
      expect(card.intentionalDifference.length).toBeGreaterThan(0);
      expect(card.whatMustNotCopy.length).toBeGreaterThan(0);
      expect(card.researchContext.researchConfidence).toBeGreaterThan(0);
    }
  });

  it("rejects a mechanical near-duplicate even when its setting is changed", async () => {
    const outputs = await allDesignerOutputs();
    const base = outputs[0]!.candidates[0]!;
    const rankedBase: ConceptHypothesisSpecV1 = { ...base, researchConfidence: 0.99 };
    const reskin: ConceptHypothesisSpecV1 = {
      ...base,
      candidateId: "candidate-reskin-only",
      concept: {
        ...base.concept,
        conceptId: "concept-reskin-only",
        setting: "A completely different candy-colored ocean planet.",
        artDirection: "Bright toy-like shapes instead of industrial science fiction.",
      },
      researchConfidence: 1,
      whatIsNew: "Only the setting and art were changed; the mechanical core intentionally remains identical for the duplicate test.",
    };
    validateConceptHypothesisGrounding(reskin, evidencePack());

    const candidates = outputs.flatMap((output) => output.candidates);
    const result = curateConceptCandidates({
      candidates: [reskin, rankedBase, ...candidates.slice(1, 11)],
      evidencePack: evidencePack(),
      generatedAt: "2026-08-20T12:10:00.000Z",
    });
    const selectedIds = new Set(result.batch.cards.flatMap((card) => card.sourceCandidateIds));
    expect(selectedIds.has("candidate-reskin-only") && selectedIds.has(base.candidateId)).toBe(false);
    expect(
      result.rejected.some(
        (item) =>
          (item.candidateId === "candidate-reskin-only" || item.candidateId === base.candidateId) &&
          item.reasons.some((reason) => reason.includes("same_core_mechanic_and_dependency")),
      ),
    ).toBe(true);
  });

  it("fails closed on an orphan candidate evidence ID", async () => {
    const outputs = await allDesignerOutputs();
    const invalid: ConceptHypothesisSpecV1 = {
      ...outputs[0]!.candidates[0]!,
      supportingEvidenceIds: ["e-1", "e-2", "orphan-evidence"],
    };
    expect(() => validateConceptHypothesisGrounding(invalid, evidencePack())).toThrow(
      /CONCEPT_COUNCIL_ORPHAN_EVIDENCE/,
    );
  });
});

describe("Stage 4.5 PR5 member restart boundary", () => {
  it("does not re-run a designer after its typed output was durably persisted", async () => {
    const outputs = await allDesignerOutputs();
    const existing = outputs[0]!;
    const context: ConceptCouncilMemberJobContext = {
      researchRunId: existing.researchRunId,
      evidencePackId: existing.evidencePackId,
      designerRole: existing.designerRole,
      objective: objective(),
      evidencePack: evidencePack(),
      creativeRunId: "creative-mechanics",
      rootFactoryJobId: "root-job",
      rootCreativeRunId: "root-run",
      existingOutput: existing,
    };
    const repository = {
      beginMemberJob: vi.fn().mockResolvedValue(context),
      persistMemberOutput: vi.fn(),
    };
    const executor = { execute: vi.fn() };
    const services = {
      conceptCouncil: repository,
      conceptCouncilDesignerExecutor: executor,
    } as unknown as WorkflowServices;

    const outcome = await conceptCouncilMemberV1({
      jobId: "job-mechanics",
      workflowKind: "concept_council_member",
      workflowVersion: 1,
      currentStage: "concept_council_assigned",
      state: {},
      retryCount: 0,
      signal: new AbortController().signal,
      services,
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.state).toMatchObject({ recovered_from_persisted_output: true });
    expect(executor.execute).not.toHaveBeenCalled();
    expect(repository.persistMemberOutput).not.toHaveBeenCalled();
  });
});
