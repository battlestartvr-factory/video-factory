import { describe, expect, it } from "vitest";
import { discoveryRoutingSnapshot } from "@/lib/game-discovery/model-policy";

describe("Stage 4 model routing", () => {
  it("keeps durable discovery reasoning off the failing Claude route", () => {
    const policy = discoveryRoutingSnapshot();
    for (const entry of Object.values(policy)) {
      expect(entry.primaryModel).not.toMatch(/^claude-/);
      expect(entry.fallbackModels).not.toContain("claude-sonnet-5");
      expect(entry.fallbackModels).not.toContain("claude-haiku-4-5");
    }
    expect(policy.concept_exploration.primaryModel).toBe("gemini-3-pro");
    expect(policy.schema_repair.primaryModel).toBe("gemini-3-6-flash");
  });
});
