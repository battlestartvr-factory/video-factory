import { describe, expect, it } from "vitest";
import { fallbackGameplayReferenceFeedback } from "../../lib/game-discovery/feedback-memory";

describe("gameplay reference feedback fallback", () => {
  it("keeps revise feedback actionable when the structuring model fails", () => {
    const feedback = fallbackGameplayReferenceFeedback({
      decision: "revise",
      rawFeedback: "Слишком реалистично. Сохрани механику, но сделай более stylized indie/AA look.",
    });

    expect(feedback.reusableScope).toBe("shot");
    expect(feedback.mustShow).toEqual([
      "Слишком реалистично. Сохрани механику, но сделай более stylized indie/AA look.",
    ]);
    expect(feedback.mustAvoid).toEqual([]);
    expect(feedback.errorTags).toEqual([]);
  });

  it("keeps reject feedback as an explicit avoid constraint without inventing tags", () => {
    const feedback = fallbackGameplayReferenceFeedback({
      decision: "reject",
      rawFeedback: "Идея слабая, не продолжать это направление.",
    });

    expect(feedback.reusableScope).toBe("concept");
    expect(feedback.mustAvoid).toEqual(["Идея слабая, не продолжать это направление."]);
    expect(feedback.mustShow).toEqual([]);
    expect(feedback.errorTags).toEqual([]);
  });
});
