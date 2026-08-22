import { describe, expect, it, vi } from "vitest";
import {
  applyHumanConceptReviews,
  isMateriallyNewConcept,
  type HumanConceptReviewState,
} from "../../lib/game-discovery/human-concept-gate";
import type {
  CoopGameConceptSpecV1,
  DiscoveryObjectiveSpecV1,
} from "../../lib/game-discovery/schemas";

function concept(overrides: Partial<CoopGameConceptSpecV1> = {}): CoopGameConceptSpecV1 {
  return {
    schema: "coop_game_concept",
    version: 1,
    conceptId: "magnetic-salvage",
    oneSentencePitch: "Two players operate opposite magnetic poles to recover unstable cargo.",
    coreMechanic: "Players independently steer attraction and repulsion forces on one shared magnetic crane.",
    coopDependency: "Neither player can position the cargo alone because each controls only one force vector.",
    playerRoles: [
      { role: "Positive pole", responsibility: "Pull and stabilize cargo from one side." },
      { role: "Negative pole", responsibility: "Push and counterbalance cargo from the other side." },
    ],
    playerCount: { min: 2, max: 2, ideal: 2 },
    interactionModel: ["shared-force-control", "physics-coordination"],
    failureMode: "Bad force timing slams the cargo into the environment and breaks valuable salvage.",
    socialMoment: "Both players blame the other after a wildly swinging object narrowly misses the exit.",
    gameplayHook: "Readable two-person physics control with immediate consequences.",
    spectacle: "Large objects swing and collide under visible magnetic forces.",
    setting: "Industrial orbital salvage yard.",
    artDirection: "Chunky stylized industrial sci-fi.",
    camera: "Third-person player-bound camera.",
    readability: "Force direction and teammate contribution are always visible.",
    noveltyAxes: [
      { axis: "dependency", choice: "split force vectors", whyDifferent: "Each player owns one half of motion." },
      { axis: "failure", choice: "shared unstable cargo", whyDifferent: "Mistakes compound physically." },
    ],
    buildability: {
      networking: "medium",
      physics: "medium",
      contentBurden: "low",
      npcAiDependency: "none",
      systemicInteractions: "medium",
      mainRisks: ["networked physics feel"],
      mvpRead: "One crane, one cargo yard, two force controls.",
    },
    referenceInfluences: [],
    ...overrides,
  };
}

function freshConcept(id: string): CoopGameConceptSpecV1 {
  return concept({
    conceptId: id,
    oneSentencePitch: "One player crosses an invisible maze while the other paints temporary geometry from sound echoes.",
    coreMechanic: "The scout emits timed sound pulses while the mapper converts returning echoes into short-lived walkable paths.",
    coopDependency: "The scout cannot see safe ground and the mapper cannot move through the maze, so progress requires continuous call-and-response.",
    interactionModel: ["asymmetric-information", "temporary-path-building"],
    failureMode: "A mistimed echo paints a false route that dissolves under the scout and resets the room.",
    socialMoment: "The mapper confidently calls a route just as the platform evaporates under the scout.",
    gameplayHook: "Read space through sound and build the other player's route in real time.",
    spectacle: "Luminous paths appear from expanding acoustic waves and then collapse.",
    setting: "Abstract acoustic ruins.",
    artDirection: "Minimal luminous geometry on dark space.",
    camera: "Over-shoulder playable camera with the teammate visible through echo silhouettes.",
    readability: "Echo rings, temporary geometry and the teammate path are visually distinct.",
    noveltyAxes: [
      { axis: "dependency", choice: "asymmetric sensing and building", whyDifferent: "Each role has exclusive information and action." },
      { axis: "failure", choice: "temporary route decay", whyDifferent: "Coordination errors erase traversable space." },
    ],
  });
}

const objective: DiscoveryObjectiveSpecV1 = {
  schema: "discovery_objective",
  version: 1,
  objectiveId: "test-objective",
  title: "Find a co-op game",
  searchIntent: "Discover a readable two-player co-op mechanic.",
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
  metadata: {},
};

function review(
  conceptId: string,
  decision: HumanConceptReviewState["decision"],
  rawFeedback: string | null = null,
): HumanConceptReviewState {
  return {
    conceptRunId: `run-${conceptId}`,
    conceptId,
    decision,
    rawFeedback,
    reviewId: `review-${conceptId}`,
  };
}

function llmWithConcepts(concepts: CoopGameConceptSpecV1[]) {
  const queue = [...concepts];
  return {
    generate: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("unexpected LLM call");
      return {
        text: JSON.stringify({ concept: next }),
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        stopReason: "stop",
        responsePayload: {},
      };
    }),
  };
}

describe("human concept reject contract", () => {
  it("rejects a cosmetic reskin of the same mechanic", () => {
    const rejected = concept();
    const reskin = concept({
      conceptId: "enchanted-salvage",
      setting: "Fantasy wizard workshop.",
      artDirection: "Hand-painted magical workshop.",
    });

    expect(isMateriallyNewConcept(rejected, reskin)).toBe(false);
  });

  it("accepts a mechanically new replacement", () => {
    expect(isMateriallyNewConcept(concept(), freshConcept("echo-cartographers"))).toBe(true);
  });

  it("drops a partially rejected card without spending a replacement LLM call", async () => {
    const first = concept({ conceptId: "concept-a" });
    const second = concept({ conceptId: "concept-b" });
    const third = concept({ conceptId: "concept-c" });
    const llm = llmWithConcepts([]);

    const result = await applyHumanConceptReviews({
      llm,
      objective,
      activeConcepts: [first, second, third],
      reviews: [
        review(first.conceptId, "approve"),
        review(second.conceptId, "reject", "Drop this direction."),
        review(third.conceptId, "approve"),
      ],
      history: [],
    });

    expect(result.activeConcepts.map((item) => item.conceptId)).toEqual(["concept-a", "concept-c"]);
    expect(result.regeneratedConcepts).toEqual([]);
    expect(result.attempts).toBe(0);
    expect(llm.generate).not.toHaveBeenCalled();
  });

  it("revises only the card explicitly marked revise", async () => {
    const source = concept({ conceptId: "concept-a" });
    const revisedDraft = concept({
      conceptId: "provider-id-is-not-authoritative",
      setting: "Flooded orbital salvage tunnels.",
    });
    const llm = llmWithConcepts([revisedDraft]);

    const result = await applyHumanConceptReviews({
      llm,
      objective,
      activeConcepts: [source],
      reviews: [review(source.conceptId, "revise", "Move the same mechanic into flooded tunnels.")],
      history: [],
    });

    expect(result.activeConcepts).toHaveLength(1);
    expect(result.regeneratedConcepts).toHaveLength(1);
    expect(result.activeConcepts[0]?.conceptId).toContain("concept-a-rev-");
    expect(result.activeConcepts[0]?.setting).toBe("Flooded orbital salvage tunnels.");
    expect(result.activeConcepts[0]?.metadata?.humanReviewLineage).toMatchObject({
      action: "revise",
      sourceConceptId: "concept-a",
    });
    expect(result.attempts).toBe(1);
    expect(llm.generate).toHaveBeenCalledTimes(1);
  });

  it("creates a complete fresh three-card cycle only when all three are rejected", async () => {
    const active = [
      concept({ conceptId: "concept-a" }),
      concept({ conceptId: "concept-b" }),
      concept({ conceptId: "concept-c" }),
    ];
    const llm = llmWithConcepts([
      freshConcept("fresh-a"),
      freshConcept("fresh-b"),
      freshConcept("fresh-c"),
    ]);

    const result = await applyHumanConceptReviews({
      llm,
      objective,
      activeConcepts: active,
      reviews: active.map((item) => review(item.conceptId, "reject", "Start a fundamentally new cycle.")),
      history: active,
    });

    expect(result.activeConcepts).toHaveLength(3);
    expect(result.regeneratedConcepts).toHaveLength(3);
    expect(new Set(result.activeConcepts.map((item) => item.conceptId)).size).toBe(3);
    expect(result.activeConcepts.every(
      (item) => (item.metadata?.humanReviewLineage as { action?: string } | undefined)?.action === "new_cycle",
    )).toBe(true);
    expect(result.attempts).toBe(3);
    expect(llm.generate).toHaveBeenCalledTimes(3);
  });
});