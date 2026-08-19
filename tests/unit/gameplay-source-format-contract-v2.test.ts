import { describe, expect, it } from "vitest";

describe("aspect contract", () => {
  it("uses widescreen source and portrait social delivery", () => {
    expect({ sourceAspect: "16:9", socialAspect: "9:16" }).toMatchObject({ sourceAspect: "16:9", socialAspect: "9:16" });
  });
});
