import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260817182500_stage3_provider_task_lifecycle.sql"),
  "utf8",
);

describe("Stage 3 provider task lifecycle migration", () => {
  it("durably prepares exactly one paid submit permission per submission_key", () => {
    expect(sql).toContain("orchestrator_prepare_provider_task");
    expect(sql).toContain("ON CONFLICT (submission_key) DO NOTHING");
    expect(sql).toContain("'should_submit', v_inserted");
    expect(sql).toContain("'submitting'");
    expect(sql).toContain("callback_token");
  });

  it("records provider identity, callback reconciliation, and canonical status separately", () => {
    expect(sql).toContain("orchestrator_record_provider_submit");
    expect(sql).toContain("orchestrator_record_provider_callback");
    expect(sql).toContain("orchestrator_record_provider_status");
    expect(sql).toContain("'provider_callback'");
    expect(sql).toContain("WHEN 'success' THEN 'succeeded'");
    expect(sql).toContain("WHEN 'fail' THEN 'failed'");
  });

  it("keeps all provider lifecycle RPCs service-role only", () => {
    expect(sql.match(/GRANT EXECUTE ON FUNCTION public\.orchestrator_/g)?.length).toBe(4);
    expect(sql.match(/FROM PUBLIC, anon, authenticated/g)?.length).toBe(4);
  });
});
