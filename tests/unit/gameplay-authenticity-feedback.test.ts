import { describe, expect, it } from "vitest";
import {
  applyGameplayAuthenticityFeedbackClassification,
  explicitlyReportsGameplayAuthenticityFailure,
  fallbackGameplayReferenceFeedback,
  gameplayReferenceFeedbackV1Schema,
} from "../../lib/game-discovery/feedback-memory";

describe("gameplay authenticity feedback classification", () => {
  it("classifies explicit Russian not-gameplay criticism as gameplay_authenticity_failure", () => {
    expect(explicitlyReportsGameplayAuthenticityFailure("это выглядит не как игра")).toBe(true);
    const feedback = fallbackGameplayReferenceFeedback({
      rawFeedback: "это выглядит не как игра, камера как в трейлере",
      decision: "revise",
    });
    expect(feedback.errorTags).toContain("gameplay_authenticity_failure");
  });

  it("does not turn an unrelated one-off visual preference into an authenticity failure", () => {
    expect(explicitlyReportsGameplayAuthenticityFailure("сделай освещение немного теплее")).toBe(false);
    const feedback = gameplayReferenceFeedbackV1Schema.parse({
      schema: "gameplay_reference_feedback",
      version: 1,
      errorTags: [],
      mustShow: ["warmer lighting"],
      mustAvoid: [],
      reusableScope: "shot",
      summary: "Use warmer lighting.",
    });
    expect(
      applyGameplayAuthenticityFeedbackClassification({
        rawFeedback: "сделай освещение немного теплее",
        feedback,
      }).errorTags,
    ).toEqual([]);
  });
});
