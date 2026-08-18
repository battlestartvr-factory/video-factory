import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260817184700_stage3_usage_accounting_scope.sql"),
  "utf8",
);

describe("Stage 3 provider accounting scope", () => {
  it("fences pricing and cost accounting to generation_image jobs", () => {
    expect(sql.match(/workflow_kind = 'generation_image'/g)?.length).toBe(2);
    expect(sql).toContain("orchestrator_apply_provider_pricing_snapshot");
    expect(sql).toContain("orchestrator_sync_provider_accounting");
  });

  it("keeps browser roles out of trigger functions", () => {
    expect(sql.match(/FROM PUBLIC, anon, authenticated/g)?.length).toBe(2);
  });
});
