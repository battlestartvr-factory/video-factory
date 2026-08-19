import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("real chat dual gameplay artifacts", () => {
  it("exposes both the 16:9 gameplay master and 9:16 social edit", async () => {
    const [card, route] = await Promise.all([
      readFile("components/chat/discovery-task-card.tsx", "utf8"),
      readFile("app/api/discovery/batches/[runId]/prototypes/[conceptRunId]/route.ts", "utf8"),
    ]);
    expect(card).toContain("Gameplay master · 16:9");
    expect(card).toContain("Social edit · 9:16");
    expect(card).toContain("Скачать gameplay master 16:9");
    expect(card).toContain("Скачать social edit 9:16");
    expect(route).toContain('url.searchParams.get("variant") === "master"');
    expect(route).toContain("assembly.landscapeMaster");
  });
});
