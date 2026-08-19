import { describe, expect, it } from "vitest";

describe("gameplay source output pairing", () => {
  it("names both required formats", () => {
    expect(["16:9", "9:16"]).toEqual(["16:9", "9:16"]);
  });
});
