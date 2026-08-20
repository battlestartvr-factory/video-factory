import { createHash } from "node:crypto";
import type { ResearchEvidenceDraftV1, ResearchScoutEvidenceBundleV1 } from "./evidence-bundle";
import type { ResearchScoutExecutionResult, ResearchScoutExecutor } from "./scout-runtime";
import type { ResearchScoutRoleV1 } from "./schemas";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const MOCK_EVIDENCE: Record<
  ResearchScoutRoleV1,
  Array<Pick<ResearchEvidenceDraftV1, "evidenceType" | "subject" | "claim" | "confidence" | "freshnessClass" | "tags">>
> = {
  market_competitor: [
    {
      evidenceType: "market_pattern",
      subject: "Readable dependency",
      claim: "Representative friends co-op games make the teammate dependency visible in the main play loop rather than hiding it in meta progression.",
      confidence: 0.82,
      freshnessClass: "recent",
      tags: ["mock", "market", "dependency"],
    },
    {
      evidenceType: "saturation_signal",
      subject: "Independent scavenging saturation",
      claim: "Independent scavenging with only occasional cooperation is a crowded pattern and is weak evidence of a distinctive co-op core by itself.",
      confidence: 0.76,
      freshnessClass: "recent",
      tags: ["mock", "saturation"],
    },
  ],
  mechanics: [
    {
      evidenceType: "mechanic_pattern",
      subject: "Shared-system dependency",
      claim: "Shared systems become mechanically legible when each player owns a necessary state transition that the other player cannot perform alone.",
      confidence: 0.9,
      freshnessClass: "evergreen",
      tags: ["mock", "mechanics", "shared-system"],
    },
    {
      evidenceType: "mechanic_pattern",
      subject: "Recoverable cascading failure",
      claim: "Recoverable cascading failure creates more co-op decisions than an instant reset because teammates must rescue the shared system after a visible mistake.",
      confidence: 0.84,
      freshnessClass: "evergreen",
      tags: ["mock", "mechanics", "recovery"],
    },
  ],
  player_voice: [
    {
      evidenceType: "player_love",
      subject: "Visible teammate mistakes",
      claim: "Players repeatedly value co-op moments where a teammate mistake is immediately visible, attributable, and recoverable together.",
      confidence: 0.81,
      freshnessClass: "recent",
      tags: ["mock", "player-love", "social"],
    },
    {
      evidenceType: "player_pain",
      subject: "Unreadable chaos",
      claim: "Chaos becomes frustrating when players cannot tell whose action caused failure or what they could have done differently.",
      confidence: 0.85,
      freshnessClass: "recent",
      tags: ["mock", "player-pain", "readability"],
    },
  ],
  gameplay_visual: [
    {
      evidenceType: "gameplay_reference_pattern",
      subject: "Gameplay camera grammar",
      claim: "Close first-person tools or a player-bound third-person camera reads as gameplay when the controllable actor, teammate dependency, and target state remain visible.",
      confidence: 0.91,
      freshnessClass: "evergreen",
      tags: ["mock", "gameplay", "camera"],
    },
    {
      evidenceType: "visual_reference_pattern",
      subject: "Action response framing",
      claim: "A readable co-op frame keeps the shared object or system in view and shows immediate world response to the player's visible action.",
      confidence: 0.88,
      freshnessClass: "evergreen",
      tags: ["mock", "visual", "world-response"],
    },
  ],
  white_space_contrarian: [
    {
      evidenceType: "white_space",
      subject: "Dependency plus role asymmetry",
      claim: "A useful white-space hypothesis is visible physical dependency combined with role asymmetry and recoverable failure, rather than a cosmetic setting mutation.",
      confidence: 0.79,
      freshnessClass: "recent",
      tags: ["mock", "white-space", "asymmetry"],
    },
    {
      evidenceType: "counterexample",
      subject: "False novelty",
      claim: "Changing only setting, character fantasy, or art direction does not make an otherwise familiar co-op dependency mechanically novel.",
      confidence: 0.94,
      freshnessClass: "evergreen",
      tags: ["mock", "counterexample", "anti-copy"],
    },
  ],
};

/**
 * Deterministic no-provider executor used only by MOCK_WORKFLOWS / tests.
 * It emits real typed source-backed evidence so the PR4 Synthesizer and PR5 Concept
 * Council can be exercised end-to-end without paid search/model calls.
 */
export class MockResearchScoutExecutor implements ResearchScoutExecutor {
  async execute(input: Parameters<ResearchScoutExecutor["execute"]>[0]): Promise<ResearchScoutExecutionResult> {
    const { context } = input;
    const now = new Date().toISOString();
    const queryCount = Math.min(
      context.assignment.queryAngles.length,
      context.assignment.budget.maxSearchQueries,
    );
    const sourceRef = `mock-source-${context.scoutRole}`;
    const url = `https://example.invalid/research/${encodeURIComponent(context.objectiveId)}/${context.scoutRole}`;
    const sourceText = `Deterministic mock source for ${context.scoutRole} and objective ${context.objectiveId}.`;
    const canPersistEvidence =
      context.assignment.budget.maxFetchedSources > 0 &&
      context.assignment.budget.maxEvidenceItems > 0;
    const drafts = canPersistEvidence
      ? MOCK_EVIDENCE[context.scoutRole].slice(0, context.assignment.budget.maxEvidenceItems)
      : [];
    const evidence = drafts.map((item, index): ResearchEvidenceDraftV1 => ({
      evidenceRef: `mock-evidence-${context.scoutRole}-${index + 1}`,
      evidenceType: item.evidenceType,
      subject: item.subject,
      claim: item.claim,
      sourceRefs: [sourceRef],
      confidence: item.confidence,
      freshnessClass: item.freshnessClass,
      observedAt: now,
      tags: item.tags,
      metadata: { mock: true, objective_id: context.objectiveId },
    }));
    const bundle: ResearchScoutEvidenceBundleV1 = {
      schema: "research_scout_evidence_bundle",
      version: 1,
      researchRunId: context.researchRunId,
      scoutRole: context.scoutRole,
      sources: canPersistEvidence
        ? [
            {
              sourceRef,
              canonicalUrl: url,
              urlSha256: sha256(url),
              sourceType: "mock_web_page",
              title: `Mock ${context.scoutRole} source`,
              observedAt: now,
              fetchedAt: now,
              contentSha256: sha256(sourceText),
              extractedText: sourceText,
              relevanceScore: 0.8,
              reusedFromCache: false,
              metadata: { mock: true },
            },
          ]
        : [],
      evidence,
    };

    return {
      report: {
        schema: "research_scout_report",
        version: 1,
        researchRunId: context.researchRunId,
        scoutRole: context.scoutRole,
        summary: `Mock Scout completed the ${context.scoutRole} mandate for objective ${context.objectiveId}.`,
        sourceIds: bundle.sources.map((source) => source.sourceRef),
        evidenceIds: evidence.map((item) => item.evidenceRef),
        imageCandidateIds: [],
        queriesExecuted: queryCount,
        coverageNotes: [
          canPersistEvidence ? "mock_source_backed_evidence" : "mock_budget_prevented_evidence",
        ],
        warnings: [],
        generatedAt: now,
      },
      evidenceBundle: bundle,
      usage: { modelCalls: 0, mock: true },
      model: "mock-research-scout",
      provider: "mock",
    };
  }
}
