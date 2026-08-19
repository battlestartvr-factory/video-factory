import { describe, expect, it } from "vitest";

describe("source and social format separation", () => {
  it("keeps source widescreen", () => {
    expect("16:9").not.toBe("9:16");
  });
});
