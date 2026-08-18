import { describe, expect, it } from "vitest";
import {
  assessConceptDiversity,
  compareConceptDiversity,
  conceptDiversitySignature,
  type CoopGameConceptSpecV1,
} from "../../lib/game-discovery";

function concept(overrides: Partial<CoopGameConceptSpecV1> = {}): CoopGameConceptSpecV1 {
  return {
    schema: "coop_game_concept",
    version: 1,
    conceptId: "concept-a",
    oneSentencePitch: "Two players operate one unstable cargo machine.",
    coreMechanic: "Both players manipulate separate controls on one unstable machine.",
    coopDependency: "shared object controls",
    playerRoles: [
      { role: "pilot", responsibility: "steer" },
      { role: "stabilizer", responsibility: "counterbalance" },
    ],
    playerCount: { min: 2, max: 4, ideal: 2 },
    interactionModel: ["shared_object"],
    failureMode: "small mistakes cascade into a physical crash",
    socialMoment: "panic and blame while recovering together",
    gameplayHook: "both players visibly fight the same machine",
    spectacle: "wobbling cargo and sparks",
    setting: "industrial facility",
    artDirection: "stylized readable 3D",
    camera: "close third person",
    readability: "both roles and the machine remain visible",
    noveltyAxes: [
      { axis: "dependency_type", choice: "shared_object", whyDifferent: "one object, split controls" },
      { axis: "social_tension", choice: "blame", whyDifferent: "mistakes are attributable" },
      { axis: "tempo", choice: "continuous", whyDifferent: "constant coordination" },
      { axis: "camera_scale", choice: "close_third_person", whyDifferent: "readable body language" },
      { axis: "failure_signature", choice: "cascade", whyDifferent: "small errors compound" },
      { axis: "buildability_shape", choice: "one_systemic_object", whyDifferent: "small content surface" },
    ],
    buildability: {
      networking: "medium",
      physics: "medium",
      contentBurden: "low",
      npcAiDependency: "none",
      systemicInteractions: "medium",
      mainRisks: ["networked physics"],
      mvpRead: "one room can prove it",
    },
    referenceInfluences: [],
    ...overrides,
  };
}

describe("Stage 4 deterministic diversity guard", () => {
  it("creates stable normalized signatures", () => {
    const signature = conceptDiversitySignature(concept());
    expect(signature.dependencyType).toBe("shared object");
    expect(signature.socialTension).toBe("blame");
    expect(signature.failureSignature).toBe("cascade");
  });

  it("hard-rejects a concept with the same core mechanic and dependency", () => {
    const reference = concept({ conceptId: "reference" });
    const candidate = concept({
      conceptId: "candidate",
      socialMoment: "players laugh instead of blame",
    });
    const comparison = compareConceptDiversity(candidate, reference);

    expect(comparison.hardDuplicate).toBe(true);
    expect(comparison.reasons).toContain("same_core_mechanic_and_dependency");
  });

  it("hard-rejects the same dependency/social/failure triple even when wording changes", () => {
    const reference = concept({ conceptId: "reference" });
    const candidate = concept({
      conceptId: "candidate",
      coreMechanic: "Players pull ropes around a shared platform.",
      noveltyAxes: reference.noveltyAxes.map((axis) =>
        axis.axis === "camera_scale"
          ? { ...axis, choice: "top_down" }
          : axis.axis === "tempo"
            ? { ...axis, choice: "turn_based" }
            : axis,
      ),
    });
    const comparison = compareConceptDiversity(candidate, reference);

    expect(comparison.hardDuplicate).toBe(true);
    expect(comparison.reasons).toContain("same_dependency_social_failure_triple");
  });

  it("accepts concepts that differ across several product axes", () => {
    const reference = concept({ conceptId: "reference" });
    const candidate = concept({
      conceptId: "candidate",
      coreMechanic: "One player sees a map while the other physically routes a creature through darkness.",
      coopDependency: "information asymmetry",
      socialMoment: "trust and miscommunication",
      failureMode: "wrong verbal instruction causes an immediate trap",
      camera: "split perspective",
      noveltyAxes: [
        { axis: "dependency_type", choice: "information_asymmetry", whyDifferent: "split knowledge" },
        { axis: "social_tension", choice: "trust", whyDifferent: "one player must believe the other" },
        { axis: "tempo", choice: "bursty", whyDifferent: "quiet planning then panic" },
        { axis: "camera_scale", choice: "split_perspective", whyDifferent: "different information" },
        { axis: "failure_signature", choice: "instruction_error", whyDifferent: "verbal mistakes become visible" },
        { axis: "buildability_shape", choice: "authored_rooms", whyDifferent: "little physics" },
      ],
      buildability: {
        networking: "low",
        physics: "low",
        contentBurden: "medium",
        npcAiDependency: "none",
        systemicInteractions: "low",
        mainRisks: ["level design"],
        mvpRead: "one room and one trap are enough",
      },
    });

    const assessment = assessConceptDiversity(candidate, [reference]);
    expect(assessment.decision).toBe("accept");
    expect(assessment.nearest?.axisDistance).toBeGreaterThanOrEqual(4);
  });

  it("returns explicit nearest-concept reasons and underexplored axes for replacement", () => {
    const reference = concept({ conceptId: "reference" });
    const candidate = concept({
      conceptId: "candidate",
      coreMechanic: "A different implementation of a shared machine.",
      noveltyAxes: reference.noveltyAxes.map((axis) =>
        axis.axis === "camera_scale" ? { ...axis, choice: "top_down" } : axis,
      ),
    });

    const assessment = assessConceptDiversity(candidate, [reference]);
    expect(assessment.decision).toBe("replace");
    expect(assessment.nearest?.referenceConceptId).toBe("reference");
    expect(assessment.rejectionReasons.length).toBeGreaterThan(0);
    expect(assessment.underexploredAxes).toContain("dependency_type");
  });
});
