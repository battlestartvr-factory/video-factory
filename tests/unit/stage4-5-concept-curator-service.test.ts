import { describe, expect, it, vi } from "vitest";
import type { DiscoveryObjectiveSpecV1 } from "@/lib/game-discovery/schemas";
import {
  MockConceptCouncilDesigner,
  type ConceptCouncilDesignerRoleV1,
  type ConceptDesignerOutputSpecV1,
} from "@/lib/research-intelligence/concept-council";
import {
  ConceptCouncilCuratorService,
  MockConceptCouncilCurator,
} from "@/lib/research-intelligence/concept-curator";
import type { EvidencePackSpecV1 } from "@/lib/research-intelligence/schemas";

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
    title: "Curator acceptance",
    searchIntent: "Find mechanically necessary friends co-op games.",
    playerCount: { min: 2, max: 4 },
    platform: "pc_steam",
    desiredNovelty: "explore",
    conceptCount: 6,
    maxConceptsToPrototype: 2,
    constraints: {},
  };
}

function ref(index: number) {
  return {
    evidenceId: `e-${index}`,
    subject: `subject-${index}`,
    claim: `Evidence claim ${index}`,
    confidence: 0.9 - index * 0.01,
    sourceIds: [`s-${(index % 3) + 1}`],
  };
}

function evidencePack(): EvidencePackSpecV1 {
  return {
    schema: "evidence_pack",
    version: 1,
    packId: "pack-1",
    researchRunId: "research-run-1",
    objectiveId: "objective-1",
    marketLandscape: [ref(1)],
    mechanicLandscape: [ref(2), ref(3)],
    playerPositiveSignals: [ref(4)],
    playerPainSignals: [ref(5)],
    saturatedPatterns: [ref(6)],
    whiteSpaces: [ref(7), ref(8), ref(9)],
    counterexamples: [ref(10)],
    gameplayReferencePatterns: [ref(11), ref(12)],
    visualReferencePatterns: [],
    contradictions: [],
    selectedSourceIds: ["s-1", "s-2", "s-3"],
    selectedImageReferenceIds: [],
    coverage: { total_evidence: 12 },
    generatedAt: "2026-08-20T12:00:00.000Z",
  };
}

async function outputs(): Promise<ConceptDesignerOutputSpecV1[]> {
  const designer = new MockConceptCouncilDesigner(() => new Date("2026-08-20T12:01:00.000Z"));
  return Promise.all(
    roles.map(async (designerRole) =>
      (await designer.execute({ objective: objective(), evidencePack: evidencePack(), designerRole })).output,
    ),
  );
}

function fanoutStatus(designerOutputs: ConceptDesignerOutputSpecV1[]) {
  return {
    researchRunId: "research-run-1",
    evidencePackId: "pack-1",
    designerCount: 3,
    terminalCount: 3,
    completedCount: 3,
    failedCount: 0,
    allTerminal: true,
    items: designerOutputs.map((output, index) => ({
      designerRole: output.designerRole,
      factoryJobId: `job-${index}`,
      creativeRunId: `creative-${index}`,
      jobStatus: "completed",
      retryCount: 0,
      error: null,
      output,
    })),
  };
}

describe("Stage 4.5 PR5 bounded Concept Curator", () => {
  it("waits for all three durable Designers and performs one bounded 12 -> 6 Curator call", async () => {
    const designerOutputs = await outputs();
    const curator = new MockConceptCouncilCurator(() => new Date("2026-08-20T12:02:00.000Z"));
    const execute = vi.spyOn(curator, "execute");
    const repository = {
      getCuratedBatch: vi.fn().mockResolvedValue(null),
      getFanoutStatus: vi.fn().mockResolvedValue(fanoutStatus(designerOutputs)),
      persistCuratedBatch: vi.fn(async ({ batch }: { batch: unknown }) => ({ duplicate: false, batch })),
    };
    const service = new ConceptCouncilCuratorService(repository as never, curator);

    const result = await service.run({
      researchRunId: "research-run-1",
      evidencePack: evidencePack(),
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.rawCandidateCount).toBe(12);
    expect(result.batch.cards).toHaveLength(6);
    expect(result.reusedFromPersistence).toBe(false);
    expect(repository.persistCuratedBatch).toHaveBeenCalledTimes(1);
  });

  it("reuses a persisted six-card curation after restart without another Curator call", async () => {
    const designerOutputs = await outputs();
    const firstCurator = new MockConceptCouncilCurator(() => new Date("2026-08-20T12:02:00.000Z"));
    const firstRepository = {
      getCuratedBatch: vi.fn().mockResolvedValue(null),
      getFanoutStatus: vi.fn().mockResolvedValue(fanoutStatus(designerOutputs)),
      persistCuratedBatch: vi.fn(async ({ batch }: { batch: unknown }) => ({ duplicate: false, batch })),
    };
    const first = await new ConceptCouncilCuratorService(firstRepository as never, firstCurator).run({
      researchRunId: "research-run-1",
      evidencePack: evidencePack(),
    });

    const secondExecutor = { execute: vi.fn() };
    const secondRepository = {
      getCuratedBatch: vi.fn().mockResolvedValue(first.batch),
      getFanoutStatus: vi.fn(),
      persistCuratedBatch: vi.fn(),
    };
    const recovered = await new ConceptCouncilCuratorService(secondRepository as never, secondExecutor).run({
      researchRunId: "research-run-1",
      evidencePack: evidencePack(),
    });

    expect(recovered.reusedFromPersistence).toBe(true);
    expect(recovered.batch).toEqual(first.batch);
    expect(secondExecutor.execute).not.toHaveBeenCalled();
    expect(secondRepository.getFanoutStatus).not.toHaveBeenCalled();
    expect(secondRepository.persistCuratedBatch).not.toHaveBeenCalled();
  });
});
