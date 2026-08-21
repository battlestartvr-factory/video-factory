import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SharedSourcePoolResearchScoutExecutor,
  sanitizeSharedPoolEvidenceClaim,
  type SharedPoolRoleAnalyzer,
} from "@/lib/research-intelligence/shared-source-pool-scout";
import type { ResearchScoutJobContext } from "@/lib/research-intelligence/scout-runtime";
import type { ResearchScoutRoleV1 } from "@/lib/research-intelligence/schemas";
import {
  sharedResearchSourcePoolV1Schema,
  sourceCoverageCategories,
} from "@/lib/research-intelligence/shared-source-pool";

const roles: ResearchScoutRoleV1[] = [
  "market_competitor",
  "mechanics",
  "player_voice",
  "gameplay_visual",
  "white_space_contrarian",
];

function context(role: ResearchScoutRoleV1): ResearchScoutJobContext {
  return {
    researchRunId: "run-1",
    scoutRole: role,
    assignment: {
      role,
      mandate: `Analyze ${role} evidence from the verified shared source pool.`,
      queryAngles: ["co-op evidence"],
      freshness: "mixed",
      sourcePreferences: [],
      forbiddenOverlap: [],
      imageSearchRequired: role === "gameplay_visual",
      budget: {
        maxSearchQueries: 4,
        maxFetchedSources: 6,
        maxEvidenceItems: 6,
        maxImageCandidates: role === "gameplay_visual" ? 5 : 0,
        maxModelCalls: 1,
      },
    },
    creativeRunId: `creative-${role}`,
    rootFactoryJobId: "root-job",
    rootCreativeRunId: "root-run",
    objectiveId: "objective-1",
    existingReport: null,
  };
}

function pool() {
  return sharedResearchSourcePoolV1Schema.parse({
    schema: "shared_research_source_pool",
    version: 1,
    researchRunId: "run-1",
    acquisitionOwnerJobId: "job-owner",
    query: "Broad co-op research across all five council dimensions.",
    generatedAt: "2026-08-21T07:00:00.000Z",
    usage: { provider_calls: 1, search_calls: 1, search_ms: 1200 },
    sources: [
      {
        source: {
          sourceRef: "pool-source-1",
          canonicalUrl: "https://example.com/game-review",
          urlSha256: "a".repeat(64),
          sourceType: "web_page",
          title: "Co-op game review",
          observedAt: "2026-08-21T07:00:00.000Z",
          extractedText: "Players in community reviews praise the chaotic fun with friends, but repeated waiting and unfair random failures become frustrating. The physics mechanic makes teammates coordinate movement and rescue each other after mistakes.",
          relevanceScore: 0.95,
          reusedFromCache: false,
          metadata: {
            domain: "example.com",
            page_image_candidate_count: 2,
            research_source_categories: ["player_voice", "mechanics", "contrarian"],
          },
        },
        groundedClaims: [
          "Players repeatedly praise chaotic co-op moments with friends when failures remain recoverable.",
          "The physics mechanic requires teammates to coordinate movement and rescue each other after mistakes.",
        ],
      },
      {
        source: {
          sourceRef: "pool-source-2",
          canonicalUrl: "https://store.example.com/competitor",
          urlSha256: "b".repeat(64),
          sourceType: "web_page",
          title: "Existing arena co-op competitor",
          observedAt: "2026-08-21T07:00:00.000Z",
          extractedText: "The existing Steam competitor uses an arena camera, exaggerated abilities, grapple movement and spectator-style presentation. Its gameplay screenshots keep teammates and interactive arena objects visible.",
          relevanceScore: 0.9,
          reusedFromCache: false,
          metadata: {
            domain: "store.example.com",
            page_image_candidate_count: 3,
            research_source_categories: ["competitor", "mechanics", "gameplay_visual", "contrarian"],
          },
        },
        groundedClaims: [
          "An existing Steam competitor already combines arena play with exaggerated movement abilities, weakening a broad novelty claim.",
          "Gameplay screenshots keep teammates and interactive arena objects visible in the camera framing.",
        ],
      },
    ],
  });
}

function analyzer(): SharedPoolRoleAnalyzer {
  return {
    async analyze(input) {
      const items = (() => {
        switch (input.role) {
          case "market_competitor":
            return [
              {
                sourceRef: "pool-source-2",
                evidenceType: "market_pattern",
                claim: "An existing arena co-op competitor already combines exaggerated movement abilities with a spectator-friendly presentation.",
                confidence: 0.9,
              },
              {
                sourceRef: "pool-source-2",
                evidenceType: "saturation_signal",
                claim: "Arena co-op built around exaggerated movement is established enough that a broad novelty claim needs a more specific differentiator.",
                confidence: 0.84,
              },
            ];
          case "mechanics":
            return [
              {
                sourceRef: "pool-source-1",
                evidenceType: "mechanic_pattern",
                claim: "The physics loop makes teammates coordinate movement and rescue each other after mistakes.",
                confidence: 0.92,
              },
              {
                sourceRef: "pool-source-2",
                evidenceType: "mechanic_pattern",
                claim: "Grapple movement and exaggerated abilities create a readable interaction system for arena co-op play.",
                confidence: 0.86,
              },
            ];
          case "player_voice":
            return [
              {
                sourceRef: "pool-source-1",
                evidenceType: "player_love",
                claim: "Players praise chaotic co-op moments when a mistake stays recoverable and can become a shared rescue story.",
                confidence: 0.91,
              },
              {
                sourceRef: "pool-source-1",
                evidenceType: "player_pain",
                claim: "Players become frustrated by repeated waiting and random failures that feel unfair rather than recoverable.",
                confidence: 0.89,
              },
            ];
          case "gameplay_visual":
            return [
              {
                sourceRef: "pool-source-2",
                evidenceType: "gameplay_reference_pattern",
                claim: "Arena camera framing keeps teammates and interactive objects visible during cooperative play.",
                confidence: 0.9,
              },
              {
                sourceRef: "pool-source-2",
                evidenceType: "visual_reference_pattern",
                claim: "Gameplay screenshots emphasize readable teammate spacing and nearby interactive arena objects rather than isolated character poses.",
                confidence: 0.86,
              },
            ];
          case "white_space_contrarian":
            return [
              {
                sourceRef: "pool-source-2",
                evidenceType: "counterexample",
                claim: "An existing competitor is a direct counterexample to the idea that arena co-op plus exaggerated movement is novel by itself.",
                confidence: 0.9,
              },
              {
                sourceRef: "pool-source-1",
                evidenceType: "white_space",
                claim: "A stronger opportunity is to make recovery and rescue the central dependency loop instead of treating chaos alone as the differentiator.",
                confidence: 0.78,
              },
            ];
        }
      })();

      return {
        value: {
          summary: `${input.role} analysis completed from the shared verified source pool.`,
          items,
          warnings: [],
        },
        model: "test-role-analyzer",
        usage: { totalTokenCount: 100 },
        rawText: "{}",
      };
    },
  };
}

describe("shared verified research source pool", () => {
  it("rejects URL/ledger fragments that previously leaked into evidence", () => {
    expect(sanitizeSharedPoolEvidenceClaim('\"). 2. https://vertexaisearch.cloud.google.com/grounding-api-redirect/foo')).toBeNull();
    expect(sanitizeSharedPoolEvidenceClaim("SOURCE||https://example.com|claim")).toBeNull();
    expect(sanitizeSharedPoolEvidenceClaim("The physics mechanic requires teammates to coordinate movement and rescue each other after mistakes.")).toContain("physics mechanic");
  });

  it("does not mistake an editorial or YouTube review for player-authored voice", () => {
    expect(sourceCoverageCategories({
      title: "Knockout City Review",
      domain: "www.youtube.com",
      url: "https://www.youtube.com/watch?v=Lp9YNM5_bzI",
      text: "Gameplay review footage demonstrates camera readability and team interactions.",
    })).toEqual(expect.arrayContaining(["gameplay_visual"]));
    expect(sourceCoverageCategories({
      title: "Knockout City Review",
      domain: "www.youtube.com",
      url: "https://www.youtube.com/watch?v=Lp9YNM5_bzI",
      text: "Gameplay review footage demonstrates camera readability and team interactions.",
    })).not.toContain("player_voice");

    expect(sourceCoverageCategories({
      title: "Gang Beasts review | PC Gamer",
      domain: "www.pcgamer.com",
      url: "https://www.pcgamer.com/gang-beasts-review/",
      text: "An editorial review discusses physics and controls.",
    })).toContain("contrarian");
    expect(sourceCoverageCategories({
      title: "Gang Beasts review | PC Gamer",
      domain: "www.pcgamer.com",
      url: "https://www.pcgamer.com/gang-beasts-review/",
      text: "An editorial review discusses physics and controls.",
    })).not.toContain("player_voice");

    expect(sourceCoverageCategories({
      title: "Party Animals General Discussions :: Steam Community",
      domain: "steamcommunity.com",
      url: "https://steamcommunity.com/app/1260320/discussions/0/",
      text: "Players discuss physics, controls, fun and frustration.",
    })).toContain("player_voice");
  });

  it("lets all five Scouts analyze one pool without another search call", async () => {
    for (const role of roles) {
      const progress = vi.fn();
      const executor = new SharedSourcePoolResearchScoutExecutor(
        pool(),
        progress,
        () => new Date("2026-08-21T07:00:00.000Z"),
        analyzer(),
      );
      const jobId = role === "market_competitor" ? "job-owner" : `job-${role}`;
      const result = await executor.execute({
        jobId,
        context: context(role),
        signal: new AbortController().signal,
      });

      expect(result.report.scoutRole).toBe(role);
      expect(result.report.queriesExecuted).toBe(0);
      expect(result.report.sourceIds.length).toBeGreaterThan(0);
      expect(result.report.evidenceIds.length).toBeGreaterThan(0);
      expect(result.evidenceBundle?.evidence.every((item) => !/https?:\/\//i.test(item.claim))).toBe(true);
      expect(progress).toHaveBeenCalledWith(expect.objectContaining({ eventType: "research.source_pool.reused" }));
      expect(progress).toHaveBeenCalledWith(expect.objectContaining({ eventType: "research.scout.role_analysis_completed" }));
      if (jobId === "job-owner") {
        expect(result.usage?.provider_calls).toBe(1);
        expect(result.usage?.shared_source_pool_acquisition_owner).toBe(true);
      } else {
        expect(result.usage?.provider_calls).toBe(0);
        expect(result.usage?.shared_source_pool_reused).toBe(true);
      }
      expect(result.usage?.role_analysis_provider_calls).toBe(1);
    }
  });

  it("recovers against verified post-fetch coverage with a bounded quality-first search cap", () => {
    const source = readFileSync(
      join(process.cwd(), "lib/research-intelligence/shared-source-pool.ts"),
      "utf8",
    );
    expect(source).toContain("const MAX_KIE_PROVIDER_CALLS = 6");
    expect(source).toContain("const MIN_VERIFIED_SOURCES = 4");
    expect(source).toContain("verifiedCoverageOfSources(sources)");
    expect(source).toContain("while (totalProviderCalls < MAX_KIE_PROVIDER_CALLS)");
    expect(source).toContain("allowProvenanceRecovery: false");
    expect(source).toContain("PLAYER-AUTHORED evidence only");
    expect(source).toContain("provider_call_cap: MAX_KIE_PROVIDER_CALLS");
  });
});
