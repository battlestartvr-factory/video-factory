import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260817184900_stage3_provider_path_indexes.sql"),
  "utf8",
);

describe("Stage 3 provider path indexes", () => {
  it("covers provider reconciliation and cost lineage foreign keys", () => {
    expect(sql).toContain("idx_provider_tasks_stage_id");
    expect(sql).toContain("idx_provider_tasks_provider_model_id");
    expect(sql).toContain("idx_factory_cost_events_provider_task_id");
    expect(sql).toContain("idx_factory_cost_events_stage_id");
    expect(sql).toContain("idx_factory_workflow_events_stage_id");
  });

  it("is additive-only", () => {
    expect(sql.match(/CREATE INDEX IF NOT EXISTS/g)?.length).toBe(5);
    expect(sql).not.toContain("DROP INDEX");
  });
});
