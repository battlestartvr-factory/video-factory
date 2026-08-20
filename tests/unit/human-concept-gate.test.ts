import { describe, expect, it } from "vitest";
import { isMateriallyNewConcept } from "../../lib/game-discovery/human-concept-gate";
import type { CoopGameConceptSpecV1 } from "../../lib/game-discovery/schemas";

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
    const rejected = concept();
    const replacement = concept({
      conceptId: "echo-cartographers",
      oneSentencePitch: "One player walks an invisible maze while the other paints temporary safe geometry from sound echoes.",
      coreMechanic: "The scout emits timed sound pulses while the mapper converts returning echoes into short-lived walkable paths.",
      coopDependency: "The scout cannot see safe ground and the mapper cannot move through the maze, so progress requires continuous call-and-response.",
      interactionModel: ["asymmetric-information", "temporary-path-building"],
      failureMode: "A mistimed echo paints a false route that dissolves under the scout and resets the room.",
      socialMoment: "The mapper confidently calls a route just as the platform evaporates under the scout.",
      setting: "Abstract acoustic ruins.",
      artDirection: "Minimal luminous geometry on dark space.",
    });

    expect(isMateriallyNewConcept(rejected, replacement)).toBe(true);
  });
});
