import { describe, expect, it } from "vitest";
import { compileGameplayPromptPlan } from "../../lib/game-discovery/prompt-compiler";
import { stage4GameplayReferenceSetSchema } from "../../lib/game-discovery/gameplay-reference-stage4";

const refs = stage4GameplayReferenceSetSchema.parse({
  schema: "stage4_gameplay_reference_set",
  version: 1,
  references: ["gameplay_camera", "interaction", "coop", "art_direction"].map((purpose, i) => ({
    referenceId: `ref-${i}`,
    purpose,
    gameId: `game-${i}`,
    gameName: `Game ${i}`,
    driveFileId: `drive-${i}`,
    score: 0.8,
    whySelected: ["match"],
    gameplayDescription: "A player-bound camera shows an active input, a target and a visible world response while a teammate remains inside playable distance.",
    whyThisLooksLikeGameplay: "The camera and affordance belong to the controllable player and the world responds to the visible action.",
  })),
});

const concept = {
  schema: "coop_game_concept",
  version: 1,
  conceptId: "c1",
  oneSentencePitch: "Two players salvage an unstable platform.",
  coreMechanic: "Cut supports while counterbalancing a shared load.",
  coopDependency: "One cuts while one stabilizes.",
  artDirection: "Stylized indie / AA.",
  readability: "Tool, teammate, target and response are readable.",
} as any;

const moment = {
  schema: "gameplay_moment",
  version: 1,
  momentId: "m1",
  conceptId: "c1",
  setup: "A clamp holds a load on a tilting platform.",
  hypothesis: "The cut visibly changes balance.",
  coopDependencyEvidence: "The stabilizer counters the cutter's world change.",
  socialTension: "The load starts sliding.",
  requiredVisualEvidence: ["held tool", "target clamp", "teammate", "tilt response"],
} as any;

const shot = {
  schema: "gameplay_shot",
  version: 1,
  shotId: "s1",
  momentId: "m1",
  action: "The player holds a cutting tool on the clamp.",
  actors: ["cutter", "stabilizer"],
  camera: "First-person player-bound camera.",
  environment: "Industrial salvage platform.",
  expectedEvidence: ["held tool", "target clamp", "teammate", "tilt response"],
  durationSec: 5,
  generationPlan: { imageModel: "nano-banana-2", videoModel: "kling-3" },
} as any;

describe("gameplay prompt reference lineage", () => {
  it("explains ordered reference purposes and persists the selected set", () => {
    const plan = compileGameplayPromptPlan({ concept, moment, shot, gameplayReferences: refs });
    expect(plan.imagePrompt).toContain("PURPOSE-LABELED REAL GAMEPLAY REFERENCES");
    expect(plan.imagePrompt).toContain("Reference A — GAMEPLAY_CAMERA");
    expect(plan.imagePrompt).toContain("captured while a person is actively playing");
    expect((plan.metadata as any).gameplay_reference_set).toEqual(refs);
    expect((plan.metadata as any).gameplay_reference_count).toBe(4);
  });
});
