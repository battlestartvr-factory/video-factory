import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  evidenceFingerprint,
  researchScoutEvidenceBundleV1Schema,
  type ResearchEvidenceDraftV1,
} from "@/lib/research-intelligence/evidence-bundle";
import {
  MockResearchSynthesizer,
  ResearchSynthesisService,
  validateEvidencePackReferences,
  type ResearchSynthesisInputV1,
  type ResearchSynthesisRepository,
  type ResearchSynthesizerExecutor,
} from "@/lib/research-intelligence/synthesis";
import type {
  EvidencePackSpecV1,
  ResearchEvidenceSpecV1,
  ResearchScoutReportSpecV1,
  ResearchScoutRoleV1,
} from "@/lib/research-intelligence/schemas";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260820134000_stage4_5_research_synthesis.sql"),
  "utf8",
);

const roles: ResearchScoutRoleV1[] = [
  "market_competitor",
  "mechanics",
  "player_voice",
  "gameplay_visual",
  "white_space_contrarian",
];

function report(role: ResearchScoutRoleV1, evidenceIds: string[]): ResearchScoutReportSpecV1 {
  return {
    schema: "research_scout_report",
    version: 1,
    researchRunId: "run-1",
    scoutRole: role,
    summary: `${role} completed bounded research.`,
    sourceIds: [],
    evidenceIds,
    imageCandidateIds: [],
    queriesExecuted: 1,
    coverageNotes: [],
    warnings: [],
    generatedAt: "2026-08-20T12:00:00.000Z",
  };
}

function evidence(input: {
  id: string;
  role: ResearchScoutRoleV1;
  type: ResearchEvidenceSpecV1["evidenceType"];
  subject: string;
  claim: string;
  sourceIds: string[];
  confidence?: number;
  freshness?: ResearchEvidenceSpecV1["freshnessClass"];
}): ResearchEvidenceSpecV1 {
  return {
    schema: "research_evidence",
    version: 1,
    evidenceId: input.id,
    researchRunId: "run-1",
    scoutRole: input.role,
    evidenceType: input.type,
    subject: input.subject,
    claim: input.claim,
    sourceIds: input.sourceIds,
    confidence: input.confidence ?? 0.85,
    freshnessClass: input.freshness ?? "fresh",
    observedAt: "2026-08-20T11:00:00.000Z",
    tags: [],
    metadata: {},
  };
}

function synthesisInput(): ResearchSynthesisInputV1 {
  const evidenceItems: ResearchEvidenceSpecV1[] = [
    evidence({
      id: "ev-market-a",
      role: "market_competitor",
      type: "market_pattern",
      subject: "shared tether co-op",
      claim: "Shared tether movement appears repeatedly in visible co-op competitors.",
      sourceIds: ["src-market-a"],
      confidence: 0.92,
    }),
    evidence({
      id: "ev-market-duplicate",
      role: "mechanics",
      type: "market_pattern",
      subject: "Shared Tether Co-op",
      claim: "Shared tether movement appears repeatedly in visible co-op competitors.",
      sourceIds: ["src-market-b"],
      confidence: 0.8,
    }),
    evidence({
      id: "ev-mechanic",
      role: "mechanics",
      type: "mechanic_pattern",
      subject: "asymmetric machinery",
      claim: "Two-role machinery creates readable dependency when each player controls a different failure surface.",
      sourceIds: ["src-mechanic"],
    }),
    evidence({
      id: "ev-player-love",
      role: "player_voice",
      type: "player_love",
      subject: "rescue moments",
      claim: "Players repeatedly celebrate last-second rescues caused by teammate dependency.",
      sourceIds: ["src-player"],
    }),
    evidence({
      id: "ev-visual",
      role: "gameplay_visual",
      type: "gameplay_reference_pattern",
      subject: "interaction readability",
      claim: "Close third-person framing keeps both the tool action and teammate role legible.",
      sourceIds: ["src-visual"],
    }),
    evidence({
      id: "ev-white-space",
      role: "white_space_contrarian",
      type: "white_space",
      subject: "shared tether co-op",
      claim: "A temporary tool-created dependency may preserve co-op tension without permanent tether fatigue.",
      sourceIds: ["src-white"],
      confidence: 0.9,
      freshness: "unknown",
    }),
    evidence({
      id: "ev-counterexample",
      role: "white_space_contrarian",
      type: "counterexample",
      subject: "shared tether co-op",
      claim: "Several successful co-op games avoid permanent tethering and create dependency through local tasks instead.",
      sourceIds: ["src-counter"],
      confidence: 0.88,
    }),
  ];

  return {
    researchRunId: "run-1",
    objectiveId: "objective-1",
    scoutStatuses: roles.map((role) => ({
      scoutRole: role,
      status: "completed",
      report: report(
        role,
        evidenceItems.filter((item) => item.scoutRole === role).map((item) => item.evidenceId),
      ),
    })),
    evidence: evidenceItems,
    knownSourceIds: [...new Set(evidenceItems.flatMap((item) => item.sourceIds))],
    knownImageReferenceIds: [],
    activePack: null,
  };
}

class MemorySynthesisRepository implements ResearchSynthesisRepository {
  activePack: EvidencePackSpecV1 | null = null;
  persistCalls = 0;

  constructor(private readonly input: ResearchSynthesisInputV1) {}

  async loadSynthesisInput(): Promise<ResearchSynthesisInputV1> {
    return { ...this.input, activePack: this.activePack };
  }

  async persistEvidencePack(input: {
    pack: EvidencePackSpecV1;
  }): Promise<{ duplicate: boolean; pack: EvidencePackSpecV1 }> {
    this.persistCalls += 1;
    if (this.activePack) return { duplicate: true, pack: this.activePack };
    this.activePack = input.pack;
    return { duplicate: false, pack: input.pack };
  }
}

describe("Stage 4.5 PR4 atomic evidence persistence contract", () => {
  it("adds per-Scout evidence fingerprints and an immutable bundle commit boundary", () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS evidence_fingerprint TEXT/);
    expect(migration).toMatch(
      /idx_research_evidence_scout_fingerprint[\s\S]*?run_id, scout_role, evidence_fingerprint/,
    );
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.research_scout_evidence_commits/);
    expect(migration).toContain("PRIMARY KEY (run_id, scout_role)");
    expect(migration).toContain("already committed with a different bundle hash");
  });

  it("persists source, run linkage, evidence and evidence-source provenance inside one RPC transaction", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.research_persist_scout_evidence_bundle[\s\S]*?GRANT EXECUTE ON FUNCTION public\.research_persist_scout_evidence_bundle\(JSONB\)/,
    )?.[0];
    expect(fn).toBeDefined();
    expect(fn).toContain("INSERT INTO public.research_sources");
    expect(fn).toContain("INSERT INTO public.research_run_sources");
    expect(fn).toContain("INSERT INTO public.research_evidence (");
    expect(fn).toContain("INSERT INTO public.research_evidence_sources");
    expect(fn).toContain("INSERT INTO public.research_scout_evidence_commits");
    expect(fn).not.toContain("memory_items");
  });

  it("keeps the Synthesizer boundary compact and does not return full fetched page text", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.research_get_synthesis_input[\s\S]*?GRANT EXECUTE ON FUNCTION public\.research_get_synthesis_input\(UUID\)/,
    )?.[0];
    expect(fn).toBeDefined();
    expect(fn).toContain("scout_statuses");
    expect(fn).toContain("research_evidence");
    expect(fn).not.toContain("extracted_text");
  });

  it("creates referential EvidencePack provenance and rejects orphan IDs at persistence", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.research_pack_evidence/);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.research_pack_sources/);
    expect(migration).toContain("Evidence Pack contains orphan or cross-run evidence ID");
    expect(migration).toContain("Evidence Pack contains orphan source ID in EvidenceRef");
    expect(migration).toContain("Evidence Pack selectedImageReferenceIds contains orphan image ID");
  });
});

describe("Stage 4.5 PR4 Scout evidence bundle schemas", () => {
  it("rejects evidence that points at a source outside its atomic Scout bundle", () => {
    expect(() =>
      researchScoutEvidenceBundleV1Schema.parse({
        schema: "research_scout_evidence_bundle",
        version: 1,
        researchRunId: "run-1",
        scoutRole: "mechanics",
        sources: [],
        evidence: [
          {
            evidenceRef: "ev-1",
            evidenceType: "mechanic_pattern",
            subject: "winch",
            claim: "Two players must coordinate the winch.",
            sourceRefs: ["missing-source"],
            confidence: 0.8,
            freshnessClass: "fresh",
            observedAt: "2026-08-20T11:00:00.000Z",
            tags: [],
            metadata: {},
          },
        ],
      }),
    ).toThrow(/Unknown sourceRef/);
  });

  it("keeps exact retry fingerprints stable across source order and whitespace drift", () => {
    const draft: ResearchEvidenceDraftV1 = {
      evidenceRef: "local-1",
      evidenceType: "mechanic_pattern",
      subject: "Shared  Winch",
      claim: "Players coordinate   one winch.",
      sourceRefs: ["a", "b"],
      confidence: 0.8,
      freshnessClass: "fresh",
      observedAt: "2026-08-20T11:00:00.000Z",
      tags: [],
      metadata: {},
    };
    const a = evidenceFingerprint({
      scoutRole: "mechanics",
      evidence: draft,
      sourceUrlHashes: ["b".repeat(64), "a".repeat(64)],
    });
    const b = evidenceFingerprint({
      scoutRole: "mechanics",
      evidence: { ...draft, subject: "shared winch", claim: "players coordinate one winch." },
      sourceUrlHashes: ["a".repeat(64), "b".repeat(64)],
    });
    expect(a).toBe(b);
  });
});

describe("Stage 4.5 PR4 objective to EvidencePack synthesis", () => {
  it("dedupes repeated claims, retains counterexamples, marks contradictions and applies freshness confidence", async () => {
    const input = synthesisInput();
    const repository = new MemorySynthesisRepository(input);
    const executor = new MockResearchSynthesizer(
      () => new Date("2026-08-20T12:30:00.000Z"),
      () => "00000000-0000-4000-8000-000000000004",
    );
    const service = new ResearchSynthesisService(repository, executor);

    const result = await service.run({ researchRunId: "run-1" });

    expect(result.reusedFromPersistence).toBe(false);
    expect(result.pack.schema).toBe("evidence_pack");
    expect(result.pack.marketLandscape).toHaveLength(1);
    expect(result.pack.counterexamples).toHaveLength(1);
    expect(result.pack.contradictions).toHaveLength(1);
    expect(result.pack.contradictions[0]?.evidenceIds).toEqual(
      expect.arrayContaining(["ev-market-a", "ev-counterexample"]),
    );
    const whiteSpace = result.pack.whiteSpaces.find((item) => item.evidenceId === "ev-white-space");
    expect(whiteSpace?.confidence).toBeLessThan(0.9);
    expect(new Set(result.pack.selectedSourceIds)).toEqual(new Set(input.knownSourceIds.filter((sourceId) =>
      result.pack.selectedSourceIds.includes(sourceId),
    )));
    expect(repository.persistCalls).toBe(1);
  });

  it("reuses a persisted pack after restart without calling the Synthesizer again", async () => {
    const input = synthesisInput();
    const repository = new MemorySynthesisRepository(input);
    const delegate = new MockResearchSynthesizer(
      () => new Date("2026-08-20T12:30:00.000Z"),
      () => "00000000-0000-4000-8000-000000000005",
    );
    const synthesize = vi.fn(delegate.synthesize.bind(delegate));
    const executor: ResearchSynthesizerExecutor = { synthesize };
    const service = new ResearchSynthesisService(repository, executor);

    const first = await service.run({ researchRunId: "run-1" });
    const second = await service.run({ researchRunId: "run-1" });

    expect(first.reusedFromPersistence).toBe(false);
    expect(second.reusedFromPersistence).toBe(true);
    expect(second.pack.packId).toBe(first.pack.packId);
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("fails closed if a pack contains an orphan evidence/source pointer", async () => {
    const input = synthesisInput();
    const executor = new MockResearchSynthesizer(
      () => new Date("2026-08-20T12:30:00.000Z"),
      () => "00000000-0000-4000-8000-000000000006",
    );
    const execution = await executor.synthesize({ synthesisInput: input });
    const broken: EvidencePackSpecV1 = {
      ...execution.pack,
      marketLandscape: [
        {
          evidenceId: "ev-market-a",
          subject: "shared tether co-op",
          claim: "Shared tether movement appears repeatedly in visible co-op competitors.",
          confidence: 0.9,
          sourceIds: ["orphan-source"],
        },
      ],
    };

    expect(() => validateEvidencePackReferences(broken, input)).toThrow(/orphan source ID/);
  });
});
