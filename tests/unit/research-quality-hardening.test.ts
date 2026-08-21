import { describe, expect, it } from "vitest";
import {
  hasClearResearchSourceTitleMismatch,
  normalizeResearchSourceUrl,
  sourceCoverageCategories,
  type SharedResearchSourcePoolV1,
} from "@/lib/research-intelligence/shared-source-pool";
import {
  isResearchBoilerplate,
  sanitizeSharedPoolEvidenceClaim,
  SharedSourcePoolResearchScoutExecutor,
  type SharedPoolRoleAnalyzer,
} from "@/lib/research-intelligence/shared-source-pool-scout";
import {
  compactEvidenceClaim,
  MockResearchSynthesizer,
  type ResearchSynthesisInputV1,
} from "@/lib/research-intelligence/synthesis";

const observedAt = "2026-08-21T09:00:00.000Z";

function source(input: {
  ref: string;
  url: string;
  title: string;
  text: string;
  categories: string[];
  hash: string;
}) {
  return {
    sourceRef: input.ref,
    canonicalUrl: input.url,
    urlSha256: input.hash.repeat(64).slice(0, 64),
    sourceType: "web_page",
    title: input.title,
    observedAt,
    extractedText: input.text,
    relevanceScore: 0.9,
    reusedFromCache: false,
    metadata: {
      domain: new URL(input.url).hostname,
      research_source_categories: input.categories,
      source_identity_verified: true,
      page_image_candidate_count: 0,
    },
  };
}

function playerVoicePool(): SharedResearchSourcePoolV1 {
  return {
    schema: "shared_research_source_pool",
    version: 1,
    researchRunId: "research-run-1",
    acquisitionOwnerJobId: "owner-job",
    query: "friends co-op player voice",
    generatedAt: observedAt,
    usage: { provider_calls: 1, credits_consumed: 0.1 },
    sources: [
      {
        source: source({
          ref: "pool-source-1",
          url: "https://www.reddit.com/r/gaming/comments/example/friends_coop/",
          title: "Players discuss a chaotic co-op game",
          text: "Several players praise the rescue moments because a failed jump gives a teammate a chance to save the run. Other players complain that long stun chains remove agency and make losses feel arbitrary.",
          categories: ["player_voice", "contrarian"],
          hash: "a",
        }),
        groundedClaims: [
          "Players praise rescue moments that let a teammate save a failing run.",
          "Players complain that long stun chains can make losses feel arbitrary.",
        ],
      },
      {
        source: source({
          ref: "pool-source-2",
          url: "https://example.com/review/co-op-chaos",
          title: "Review: co-op chaos works when blame is readable",
          text: "The review argues that chaotic failure stays funny when players can identify who caused it and recover quickly. It criticizes downtime after elimination because spectators stop participating.",
          categories: ["player_voice", "contrarian"],
          hash: "b",
        }),
        groundedClaims: [
          "Chaotic failure stays funny when players can identify the cause and recover quickly.",
          "Long spectator downtime weakens the social loop after elimination.",
        ],
      },
    ],
  };
}

function scoutContext() {
  return {
    researchRunId: "research-run-1",
    scoutRole: "player_voice" as const,
    assignment: {
      role: "player_voice" as const,
      mandate: "Find repeated player love and pain signals around social co-op moments.",
      queryAngles: ["player love", "player pain"],
      freshness: "mixed" as const,
      sourcePreferences: [],
      forbiddenOverlap: [],
      imageSearchRequired: false,
      budget: {
        maxSearchQueries: 4,
        maxFetchedSources: 6,
        maxEvidenceItems: 10,
        maxImageCandidates: 0,
        maxModelCalls: 1 as const,
      },
    },
    creativeRunId: "creative-run-1",
    rootFactoryJobId: "root-job-1",
    rootCreativeRunId: "root-creative-1",
    objectiveId: "objective-1",
    existingReport: null,
  };
}

describe("research quality hardening", () => {
  it("compacts long durable evidence before the Evidence Pack boundary", async () => {
    const longClaim = `${"A useful source-backed mechanic observation with concrete player consequences. ".repeat(55)}`.slice(0, 3_900);
    expect(longClaim.length).toBeGreaterThan(2_000);
    expect(compactEvidenceClaim(longClaim).length).toBeLessThanOrEqual(1_800);

    const synthesisInput: ResearchSynthesisInputV1 = {
      researchRunId: "research-run-1",
      objectiveId: "objective-1",
      scoutStatuses: [
        { scoutRole: "mechanics", status: "completed", report: null },
      ],
      evidence: [
        {
          schema: "research_evidence",
          version: 1,
          evidenceId: "evidence-long",
          researchRunId: "research-run-1",
          scoutRole: "mechanics",
          evidenceType: "mechanic_pattern",
          subject: "Test source",
          claim: longClaim,
          sourceIds: ["source-db-1"],
          confidence: 0.9,
          freshnessClass: "recent",
          observedAt,
          tags: [],
          metadata: {},
        },
      ],
      knownSourceIds: ["source-db-1"],
      knownImageReferenceIds: [],
      activePack: null,
    };

    const execution = await new MockResearchSynthesizer().synthesize({ synthesisInput });
    expect(execution.pack.mechanicLandscape).toHaveLength(1);
    expect(execution.pack.mechanicLandscape[0]!.claim.length).toBeLessThanOrEqual(2_000);
  });

  it("rejects Steam/navigation/system boilerplate but keeps useful evidence", () => {
    expect(isResearchBoilerplate("Privacy Policy | Steam Subscriber Agreement | Refunds | Cookies | Install Steam | Change language")).toBe(true);
    expect(isResearchBoilerplate("System Requirements Minimum: Requires a 64-bit processor. DirectX: Version 11 Storage: 12 GB available space.")).toBe(true);
    expect(sanitizeSharedPoolEvidenceClaim("STORE Home Discovery Queue Wishlist Points Shop News Charts COMMUNITY Home Discussions Workshop Market Broadcasts About Support Change language")).toBeNull();
    expect(sanitizeSharedPoolEvidenceClaim("Players repeatedly praise quick rescue opportunities because a teammate can turn a failed jump into a funny recovery moment.")).toContain("Players repeatedly praise");
  });

  it("does not treat a generic Steam store page as player voice or gameplay evidence", () => {
    const categories = sourceCoverageCategories({
      title: "Party Animals on Steam",
      domain: "store.steampowered.com",
      url: "https://store.steampowered.com/app/1260320/Party_Animals/",
      text: "Reviews Very Positive. Online Co-op. Physics-based multiplayer gameplay with cute animals.",
    });
    expect(categories).toContain("competitor");
    expect(categories).toContain("mechanics");
    expect(categories).not.toContain("player_voice");
    expect(categories).not.toContain("gameplay_visual");
  });

  it("recognizes actual community and gameplay source families", () => {
    expect(sourceCoverageCategories({
      title: "Players discuss what makes co-op chaos fair",
      domain: "www.reddit.com",
      url: "https://www.reddit.com/r/gaming/comments/example/co_op_chaos/",
      text: "Players discuss frustration, rescue and funny failures.",
    })).toContain("player_voice");

    expect(sourceCoverageCategories({
      title: "Party Animals gameplay - full match",
      domain: "www.youtube.com",
      url: "https://www.youtube.com/watch?v=example",
      text: "Full match footage showing camera, arena and player interactions.",
    })).toContain("gameplay_visual");
  });

  it("dedupes tracking variants and detects obvious fetched-title mismatches", () => {
    expect(normalizeResearchSourceUrl("https://store.steampowered.com/app/1260320/Party_Animals/?snr=foo&utm_source=test#reviews"))
      .toBe("https://store.steampowered.com/app/1260320/party_animals");
    expect(hasClearResearchSourceTitleMismatch("Gang Beasts on Steam", "Putt-Putt and Pep's Balloon-o-Rama on Steam")).toBe(true);
    expect(hasClearResearchSourceTitleMismatch("Gang Beasts on Steam", "Gang Beasts on Steam")).toBe(false);
  });

  it("uses semantic Scout evidence types while follower web-search calls remain zero", async () => {
    const analyzer: SharedPoolRoleAnalyzer = {
      async analyze() {
        return {
          value: {
            summary: "Players value readable rescue moments and dislike long periods without agency.",
            items: [
              {
                sourceRef: "pool-source-1",
                evidenceType: "player_love",
                claim: "Players praise rescue moments because a teammate can recover a failing run instead of watching an instant loss.",
                confidence: 0.9,
              },
              {
                sourceRef: "pool-source-2",
                evidenceType: "player_pain",
                claim: "The review criticizes long spectator downtime because eliminated players stop participating in the social loop.",
                confidence: 0.86,
              },
            ],
            warnings: [],
          },
          model: "fake-role-analyzer",
          usage: { totalTokenCount: 123 },
          rawText: "{}",
        };
      },
    };

    const executor = new SharedSourcePoolResearchScoutExecutor(
      playerVoicePool(),
      undefined,
      () => new Date(observedAt),
      analyzer,
    );
    const result = await executor.execute({
      jobId: "follower-job",
      context: scoutContext(),
      signal: new AbortController().signal,
    });

    expect(result.evidenceBundle.evidence.map((item) => item.evidenceType)).toEqual(["player_love", "player_pain"]);
    expect(result.usage?.provider_calls).toBe(0);
    expect(result.usage?.role_analysis_provider_calls).toBe(1);
  });

  it("fails closed when role analysis only returns boilerplate or invalid evidence", async () => {
    const analyzer: SharedPoolRoleAnalyzer = {
      async analyze() {
        return {
          value: {
            summary: "Weak output",
            items: [
              {
                sourceRef: "pool-source-1",
                evidenceType: "player_love",
                claim: "Privacy Policy | Steam Subscriber Agreement | Refunds | Cookies | Install Steam | Change language",
                confidence: 0.9,
              },
              {
                sourceRef: "missing-source",
                evidenceType: "player_pain",
                claim: "Players dislike waiting for teammates after elimination because it removes participation.",
                confidence: 0.8,
              },
            ],
          },
          model: "fake-role-analyzer",
          usage: {},
          rawText: "{}",
        };
      },
    };

    const executor = new SharedSourcePoolResearchScoutExecutor(
      playerVoicePool(),
      undefined,
      () => new Date(observedAt),
      analyzer,
    );

    await expect(executor.execute({
      jobId: "follower-job",
      context: scoutContext(),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "RESEARCH_SCOUT_ROLE_ANALYSIS_INSUFFICIENT" });
  });
});