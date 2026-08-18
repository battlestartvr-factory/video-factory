import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260818090000_stage4_discovery_admission.sql"),
  "utf8",
);

describe("Stage 4 discovery admission migration", () => {
  it("adds explicit parent/child durable-job lineage", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS parent_job_id UUID");
    expect(migration).toContain("factory_jobs_parent_job_id_fkey");
    expect(migration).toContain("idx_factory_jobs_parent_created");
  });

  it("atomically creates the root creative run, durable job and queue wakeup", () => {
    const fn = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION public.orchestrator_create_game_discovery_batch"),
    );

    expect(fn).toContain("INSERT INTO public.creative_runs");
    expect(fn).toContain("INSERT INTO public.factory_jobs");
    expect(fn).toContain("'game_discovery_batch'");
    expect(fn).toContain("'objective_ready'");
    expect(fn).toContain("FROM pgmq.send(");
    expect(fn).toContain("'game_discovery_created'");
    expect(fn).toContain("UPDATE public.creative_runs\n  SET factory_job_id = v_job.id");
  });

  it("is idempotent by request_id and keeps the RPC service-role only", () => {
    expect(migration).toContain("WHERE request_id = v_request_id");
    expect(migration).toContain("'duplicate', true");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.orchestrator_create_game_discovery_batch(JSONB)");
    expect(migration).toContain("FROM PUBLIC, anon, authenticated");
    expect(migration).toContain("TO service_role");
  });
});
