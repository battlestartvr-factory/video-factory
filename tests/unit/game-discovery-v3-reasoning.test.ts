import { describe, expect, it, vi } from "vitest";
import {
  buildGameDiscoveryV3ResearchPack,
  generateStrongConceptBatch,
  type StrongConceptLlm,
} from "../../lib/research-intelligence/game-discovery-v3";
import type {
  CoopGameConceptSpecV1,
  DiscoveryObjectiveSpecV1,
} from "../../lib/game-discovery/schemas";
import type { SharedResearchSourcePoolV1 } from "../../lib/research-intelligence/shared-source-pool";

const observedAt = "2026-08-22T04:00:00.000Z";

function objective(): DiscoveryObjectiveSpecV1 {
  return {
    schema: "discovery_objective",
    version: 1,
    objectiveId: "reasoning-objective",
    title: "Проверка reasoning policy",
    searchIntent: "Найти три разные идеи для кооперативной PC игры.",
    playerCount: { min: 2, max: 4 },
    platform: "pc_steam",
    desiredNovelty: "explore",
    conceptCount: 3,
    maxConceptsToPrototype: 3,
    constraints: {},
    metadata: {},
  };
}

function concept(id: string, mechanic: string): CoopGameConceptSpecV1 {
  return {
    schema: "coop_game_concept",
    version: 1,
    conceptId: id,
    oneSentencePitch: `Pitch ${mechanic}`,
    coreMechanic: `Distinct core mechanic ${mechanic}`,
    coopDependency: `Distinct necessary dependency ${mechanic}`,
    playerRoles: [
      { role: `Role A ${mechanic}`, responsibility: `Responsibility A ${mechanic}` },
      { role: `Role B ${mechanic}`, responsibility: `Responsibility B ${mechanic}` },
    ],
    playerCount: { min: 2, max: 2, ideal: 2 },
    interactionModel: [`interaction-${mechanic}`],
    failureMode: `Distinct failure ${mechanic}`,
    socialMoment: `Distinct social moment ${mechanic}`,
    gameplayHook: `Distinct gameplay hook ${mechanic}`,
    spectacle: `Distinct spectacle ${mechanic}`,
    setting: `Distinct setting ${mechanic}`,
    artDirection: `Distinct art direction ${mechanic}`,
    camera: `Distinct playable camera ${mechanic}`,
    readability: `Distinct readability ${mechanic}`,
    noveltyAxes: [
      { axis: `dependency-${mechanic}`, choice: `choice-${mechanic}`, whyDifferent: `Different dependency ${mechanic}` },
      { axis: `failure-${mechanic}`, choice: `failure-choice-${mechanic}`, whyDifferent: `Different failure ${mechanic}` },
    ],
    buildability: {
      networking: "low",
      physics: "low",
      contentBurden: "low",
      npcAiDependency: "none",
      systemicInteractions: "medium",
      mainRisks: [`risk-${mechanic}`],
      mvpRead: `Small MVP ${mechanic}`,
    },
    referenceInfluences: [],
  };
}

function pack() {
  const sha = (value: string) => value.repeat(64);
  const pool: SharedResearchSourcePoolV1 = {
    schema: "shared_research_source_pool",
    version: 1,
    researchRunId: "reasoning-research",
    acquisitionOwnerJobId: "reasoning-job",
    query: "bounded research",
    generatedAt: observedAt,
    usage: { provider_calls: 1 },
    sources: [
      {
        source: {
          sourceRef: "source-a",
          canonicalUrl: "https://example.com/a",
          urlSha256: sha("a"),
          sourceType: "web_page",
          observedAt,
          extractedText: "Source A",
          reusedFromCache: false,
          metadata: { research_source_categories: ["mechanics"] },
        },
        groundedClaims: ["A grounded mechanics claim with enough useful detail."],
      },
      {
        source: {
          sourceRef: "source-b",
          canonicalUrl: "https://example.com/b",
          urlSha256: sha("b"),
          sourceType: "web_page",
          observedAt,
          extractedText: "Source B",
          reusedFromCache: false,
          metadata: { research_source_categories: ["player_voice"] },
        },
        groundedClaims: ["A grounded player claim with enough useful detail."],
      },
      {
        source: {
          sourceRef: "source-c",
          canonicalUrl: "https://example.com/c",
          urlSha256: sha("c"),
          sourceType: "web_page",
          observedAt,
          extractedText: "Source C",
          reusedFromCache: false,
          metadata: { research_source_categories: ["contrarian"] },
        },
        groundedClaims: ["A grounded contrarian claim with enough useful detail."],
      },
    ],
  };
  return buildGameDiscoveryV3ResearchPack({ objectiveId: "reasoning-objective", pool });
}

describe("Game Discovery v3 reasoning policy", () => {
  it("uses the adapter medium tier instead of high reasoning for the strong concept pass", async () => {
    const researchPack = pack();
    const generate = vi.fn<StrongConceptLlm["generate"]>().mockResolvedValue({
      text: JSON.stringify({
        schema: "strong_concept_batch",
        version: 1,
        researchRunId: researchPack.researchRunId,
        model: "gpt-5-6-terra",
        concepts: [
          {
            concept: concept("concept-a", "split-pressure"),
            sourceRefs: ["source-a", "source-b"],
            researchRationale: "Rationale A",
            intentionalDifference: "Difference A",
            mustNotCopy: ["Do not copy A"],
          },
          {
            concept: concept("concept-b", "blind-navigation"),
            sourceRefs: ["source-b", "source-c"],
            researchRationale: "Rationale B",
            intentionalDifference: "Difference B",
            mustNotCopy: ["Do not copy B"],
          },
          {
            concept: concept("concept-c", "shared-balance"),
            sourceRefs: ["source-a", "source-c"],
            researchRationale: "Rationale C",
            intentionalDifference: "Difference C",
            mustNotCopy: ["Do not copy C"],
          },
        ],
      }),
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
      stopReason: "completed",
      responsePayload: {},
    });

    await generateStrongConceptBatch({
      llm: { generate },
      objective: objective(),
      pack: researchPack,
    });

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      model: "gpt-5-6-terra",
      thinking: false,
    });
  });
});
