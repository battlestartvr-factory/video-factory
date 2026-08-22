import { describe, expect, it } from "vitest";
import {
  buildGameDiscoveryV3ResearchPack,
  strongConceptBatchV1Schema,
  validateStrongConceptBatch,
  type GameDiscoveryResearchPackV1,
} from "../../lib/research-intelligence/game-discovery-v3";
import { gameplayDurationSeconds } from "../../lib/game-discovery/moment-planner";
import type {
  CoopGameConceptSpecV1,
  DiscoveryObjectiveSpecV1,
} from "../../lib/game-discovery/schemas";
import type { SharedResearchSourcePoolV1 } from "../../lib/research-intelligence/shared-source-pool";
import { applyV3HumanConceptAuthority } from "../../worker/workflows/game-discovery-batch-v3";
import type { WorkflowTickOutcome } from "../../worker/workflows/types";

function objective(gameplayDurationSec?: number): DiscoveryObjectiveSpecV1 {
  return {
    schema: "discovery_objective",
    version: 1,
    objectiveId: "objective-v3",
    title: "Найти новую кооперативную игру",
    searchIntent: "Найти новую игру для двух друзей с сильной взаимозависимостью.",
    playerCount: { min: 2, max: 4 },
    platform: "pc_steam",
    desiredNovelty: "explore",
    conceptCount: 3,
    maxConceptsToPrototype: 3,
    constraints: {
      maxMvpMonths: 12,
      networkingComplexity: "medium",
      contentBurden: "medium",
      npcAiDependency: "allow_light",
    },
    metadata: gameplayDurationSec === undefined ? {} : { gameplayDurationSec },
  };
}

function concept(id: string, mechanic = id): CoopGameConceptSpecV1 {
  return {
    schema: "coop_game_concept",
    version: 1,
    conceptId: id,
    oneSentencePitch: `Pitch ${id}`,
    coreMechanic: `Core mechanic ${mechanic}`,
    coopDependency: `Players split necessary control ${mechanic}`,
    playerRoles: [
      { role: "Player A", responsibility: `Controls one half of ${mechanic}` },
      { role: "Player B", responsibility: `Controls the other half of ${mechanic}` },
    ],
    playerCount: { min: 2, max: 2, ideal: 2 },
    interactionModel: [`interaction-${mechanic}`],
    failureMode: `Failure ${mechanic}`,
    socialMoment: `Social tension ${mechanic}`,
    gameplayHook: `Hook ${mechanic}`,
    spectacle: `Spectacle ${mechanic}`,
    setting: `Setting ${mechanic}`,
    artDirection: `Stylized art ${mechanic}`,
    camera: `Playable third-person camera ${mechanic}`,
    readability: `Readable mechanic ${mechanic}`,
    noveltyAxes: [
      { axis: "dependency", choice: `dependency-${mechanic}`, whyDifferent: `Different dependency ${mechanic}` },
      { axis: "failure", choice: `failure-${mechanic}`, whyDifferent: `Different failure ${mechanic}` },
    ],
    buildability: {
      networking: "medium",
      physics: "low",
      contentBurden: "low",
      npcAiDependency: "none",
      systemicInteractions: "medium",
      mainRisks: ["feel"],
      mvpRead: `Small prototype ${mechanic}`,
    },
    referenceInfluences: [],
  };
}

const observedAt = "2026-08-22T03:00:00.000Z";
const shaA = "a".repeat(64);
const shaB = "b".repeat(64);
const shaC = "c".repeat(64);

function pool(): SharedResearchSourcePoolV1 {
  return {
    schema: "shared_research_source_pool",
    version: 1,
    researchRunId: "research-v3",
    acquisitionOwnerJobId: "job-v3",
    query: "bounded co-op research",
    generatedAt: observedAt,
    usage: { provider_calls: 2 },
    sources: [
      {
        source: {
          sourceRef: "source-mechanics",
          canonicalUrl: "https://example.com/mechanics",
          urlSha256: shaA,
          sourceType: "web_page",
          title: "Mechanics source",
          observedAt,
          extractedText: "Mechanics evidence",
          reusedFromCache: false,
          metadata: { research_source_categories: ["mechanics", "competitor"] },
        },
        groundedClaims: ["Co-op roles can split control of one shared system."],
      },
      {
        source: {
          sourceRef: "source-player",
          canonicalUrl: "https://example.com/player",
          urlSha256: shaB,
          sourceType: "web_page",
          title: "Player source",
          observedAt,
          extractedText: "Player evidence",
          reusedFromCache: false,
          metadata: { research_source_categories: ["player_voice"] },
        },
        groundedClaims: ["Players value failures that are understandable and socially attributable."],
      },
      {
        source: {
          sourceRef: "source-visual",
          canonicalUrl: "https://example.com/visual",
          urlSha256: shaC,
          sourceType: "web_page",
          title: "Gameplay source",
          observedAt,
          extractedText: "Gameplay evidence",
          reusedFromCache: false,
          metadata: { research_source_categories: ["gameplay_visual", "contrarian"] },
        },
        groundedClaims: ["Readable gameplay framing keeps both player action and shared consequence visible."],
      },
    ],
  };
}

function researchPack(): GameDiscoveryResearchPackV1 {
  return buildGameDiscoveryV3ResearchPack({ objectiveId: "objective-v3", pool: pool() });
}

describe("Game Discovery v3 simplified graph", () => {
  it("builds one compact research pack from verified sources with deterministic coverage", () => {
    const pack = researchPack();
    expect(pack.researchRunId).toBe("research-v3");
    expect(pack.sources).toHaveLength(3);
    expect(pack.coverage).toMatchObject({
      total_sources: 3,
      competitor: 1,
      mechanics: 1,
      player_voice: 1,
      gameplay_visual: 1,
      contrarian: 1,
    });
    expect(pack.sources[0]?.groundedClaims[0]).toContain("shared system");
  });

  it("requires exactly three source-grounded concepts", () => {
    const pack = researchPack();
    const candidates = [
      { concept: concept("concept-a", "split-pressure"), sourceRefs: ["source-mechanics", "source-player"], researchRationale: "Grounded A", intentionalDifference: "Different A", mustNotCopy: ["Do not copy identities"] },
      { concept: concept("concept-b", "blind-navigation"), sourceRefs: ["source-player", "source-visual"], researchRationale: "Grounded B", intentionalDifference: "Different B", mustNotCopy: ["Do not copy layouts"] },
      { concept: concept("concept-c", "shared-balance"), sourceRefs: ["source-mechanics", "source-visual"], researchRationale: "Grounded C", intentionalDifference: "Different C", mustNotCopy: ["Do not copy branded UI"] },
    ];
    const valid = strongConceptBatchV1Schema.parse({
      schema: "strong_concept_batch",
      version: 1,
      researchRunId: pack.researchRunId,
      model: "gpt-5-6-terra",
      concepts: candidates,
    });

    expect(validateStrongConceptBatch({ batch: valid, pack }).concepts).toHaveLength(3);
    expect(strongConceptBatchV1Schema.safeParse({ ...valid, concepts: candidates.slice(0, 2) }).success).toBe(false);
    expect(strongConceptBatchV1Schema.safeParse({ ...valid, concepts: [...candidates, candidates[0]] }).success).toBe(false);
  });

  it.each([
    { approvedIds: ["a"] },
    { approvedIds: ["a", "b"] },
    { approvedIds: ["a", "b", "c"] },
  ])(
    "sends $approvedIds human-approved concepts directly to gameplay moments with no AI veto",
    ({ approvedIds }) => {
      const legacyOutcome: WorkflowTickOutcome = {
        status: "waiting",
        currentStage: "pre_evaluation_pending",
        progress: 40,
        nextActionAt: observedAt,
        state: {
          concept_ids: approvedIds,
          human_approved_concept_ids: approvedIds,
          human_concept_gate_passed: true,
        },
        stateReason: "legacy_human_gate_passed",
        eventType: "discovery.concept_gate_passed",
      };

      const outcome = applyV3HumanConceptAuthority(
        "human_concept_approval_pending",
        legacyOutcome,
        observedAt,
      );

      expect(outcome.currentStage).toBe("planning_moments_pending");
      expect(outcome.state?.selected_concept_ids).toEqual(approvedIds);
      expect(outcome.state?.v3_ai_pre_evaluation_skipped).toBe(true);
      expect(outcome.state?.concept_pre_evaluations).toEqual([]);
      expect(outcome.enqueueReason).toBe("gameplay_moment_planning");
    },
  );

  it("does not rewrite unrelated downstream stages", () => {
    const outcome: WorkflowTickOutcome = {
      status: "waiting",
      currentStage: "human_reference_approval_pending",
      progress: 85,
      state: { selected_concept_ids: ["a"] },
    };
    expect(applyV3HumanConceptAuthority("human_reference_approval_pending", outcome)).toBe(outcome);
  });

  it("fails closed if a purported passed Human Concept Gate has no approved selection", () => {
    const outcome = applyV3HumanConceptAuthority("human_concept_approval_pending", {
      status: "waiting",
      currentStage: "pre_evaluation_pending",
      state: {},
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("V3_HUMAN_APPROVAL_SELECTION_MISSING");
  });

  it("snaps requested gameplay duration to Kling 3 supported values", () => {
    expect(gameplayDurationSeconds(objective())).toBe(5);
    expect(gameplayDurationSeconds(objective(7))).toBe(5);
    expect(gameplayDurationSeconds(objective(8))).toBe(10);
    expect(gameplayDurationSeconds(objective(12))).toBe(10);
    expect(gameplayDurationSeconds(objective(14))).toBe(15);
  });
});