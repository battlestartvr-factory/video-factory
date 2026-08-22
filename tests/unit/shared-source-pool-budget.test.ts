import { describe, expect, it } from "vitest";
import type { DiscoveryObjectiveSpecV1 } from "../../lib/game-discovery/schemas";
import { buildGameDiscoveryV2ResearchPlan, resolveResearchPolicyV1 } from "../../lib/research-intelligence/game-discovery-v2";
import { resolveSharedPoolProviderCallCap } from "../../lib/research-intelligence/shared-source-pool";

const objective: DiscoveryObjectiveSpecV1 = {
  schema: "discovery_objective",
  version: 1,
  objectiveId: "budget-test",
  title: "Budget test",
  searchIntent: "Find mechanically distinct four-player co-op game opportunities.",
  playerCount: { min: 2, max: 4 },
  platform: "pc_steam",
  desiredNovelty: "explore",
  conceptCount: 3,
  maxConceptsToPrototype: 3,
  constraints: {},
  metadata: {},
};

function plan(maxQueries: number) {
  const policy = resolveResearchPolicyV1({
    mode: "required",
    freshness: "mixed",
    maxQueries,
    maxSources: 4,
    maxImageCandidates: 0,
    allowExternalImageReferences: false,
    allowGameplayLibraryPromotion: false,
  });
  return buildGameDiscoveryV2ResearchPlan({
    researchRunId: `research-${maxQueries}`,
    objective,
    policy,
  });
}

describe("shared source pool provider-call budget", () => {
  it("honors a one-query Research Plan as a one-provider-call cap", () => {
    expect(resolveSharedPoolProviderCallCap(plan(1))).toBe(1);
  });

  it("never exceeds the absolute production hard cap", () => {
    expect(resolveSharedPoolProviderCallCap(plan(20))).toBe(6);
  });
});
