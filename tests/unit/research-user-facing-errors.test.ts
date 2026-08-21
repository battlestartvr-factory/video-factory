import { describe, expect, it } from "vitest";
import { researchUserFacingFailure } from "@/lib/research-intelligence/user-facing-errors";

describe("research user-facing failures", () => {
  it("maps synthesis failures to a stable friendly message", () => {
    const result = researchUserFacingFailure({
      code: "RESEARCH_SYNTHESIS_FAILED",
      message: "internal message should not be rendered",
    });

    expect(result.code).toBe("RESEARCH_SYNTHESIS_FAILED");
    expect(result.message).toContain("Evidence Pack");
    expect(result.message).not.toContain("internal message");
  });

  it("hides large Zod/JSON diagnostics from the chat surface", () => {
    const technical = JSON.stringify({
      issues: Array.from({ length: 20 }, (_, index) => ({
        code: "too_big",
        path: ["mechanicLandscape", index, "claim"],
        message: "Too big: expected string to have <=2000 characters",
      })),
    });
    const result = researchUserFacingFailure({
      code: "WORKFLOW_EXECUTION_ERROR",
      message: technical,
    });

    expect(result.code).toBe("WORKFLOW_EXECUTION_ERROR");
    expect(result.message.length).toBeLessThan(220);
    expect(result.message).not.toContain("mechanicLandscape");
    expect(result.message).not.toContain("too_big");
  });

  it("keeps a short non-technical backend message for unknown failures", () => {
    expect(researchUserFacingFailure({ code: "CUSTOM_FAILURE", message: "Source host is temporarily unavailable." })).toEqual({
      code: "CUSTOM_FAILURE",
      message: "Source host is temporarily unavailable.",
    });
  });
});
