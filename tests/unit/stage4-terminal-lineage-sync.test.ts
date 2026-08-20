import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260820081126_stage4_root_creative_run_terminal_sync.sql",
  ),
  "utf-8",
);

describe("Stage 4 terminal lineage synchronization", () => {
  it("synchronizes terminal factory-job status only to root creative runs", () => {
    expect(migration).toMatch(/AFTER UPDATE OF status ON public\.factory_jobs/);
    expect(migration).toMatch(/NEW\.status IN \('completed', 'failed', 'cancelled'\)/);
    expect(migration).toMatch(/cr\.factory_job_id = NEW\.id/);
    expect(migration).toMatch(/cr\.parent_run_id IS NULL/);
    expect(migration).toMatch(/cr\.status NOT IN \('completed', 'failed', 'cancelled'\)/);
  });

  it("backfills historical terminal mismatches without touching child runs", () => {
    expect(migration).toMatch(/FROM public\.factory_jobs AS fj/);
    expect(migration).toMatch(/cr\.factory_job_id = fj\.id/);
    expect(migration).toMatch(/fj\.status IN \('completed', 'failed', 'cancelled'\)/);
    expect(migration.match(/cr\.parent_run_id IS NULL/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
