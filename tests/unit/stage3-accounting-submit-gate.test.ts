import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260817185000_stage3_accounting_submit_gate.sql"),
  "utf8",
);

describe("Stage 3 provider accounting submit gate", () => {
  it("keeps prepared-but-unsubmitted provider tasks at zero effective cost", () => {
    expect(sql).toContain("prepared_not_submitted_zero");
    expect(sql).toContain("NEW.submission_attempts > 0");
    expect(sql).toContain("NEW.external_task_id IS NOT NULL");
  });

  it("wakes accounting explicitly when the paid submit permit is consumed", () => {
    expect(sql).toContain("submission_attempts,");
    expect(sql).toContain("external_task_id,");
    expect(sql).toContain("provider_tasks_sync_accounting");
  });

  it("remains unavailable to browser roles", () => {
    expect(sql).toContain("FROM PUBLIC, anon, authenticated");
  });
});
