import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("assembly archive variants", () => {
  it("uses distinct durable filenames for landscape master and vertical social edit", async () => {
    const source = await readFile("lib/game-discovery/assembly-drive-archive.ts", "utf8");
    expect(source).toContain('"landscape_master" | "vertical_social"');
    expect(source).toContain("gameplay-master-16x9-v1-");
    expect(source).toContain("social-edit-9x16-v1-");
  });
});
