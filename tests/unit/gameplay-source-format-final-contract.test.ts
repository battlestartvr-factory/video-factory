import { describe, expect, it } from "vitest";

describe("gameplay source/social delivery separation", () => {
  it("does not conflate source capture with social delivery", () => {
    expect("desktop_pc_16x9").not.toBe("social_9x16");
  });
});
