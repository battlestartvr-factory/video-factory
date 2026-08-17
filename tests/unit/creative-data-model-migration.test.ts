import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260817130000_creative_data_model.sql"),
  "utf-8",
);

describe("creative data model migration", () => {
  it("is additive and does not destroy data", () => {
    expect(migration).not.toMatch(/\bDROP TABLE\b/i);
    expect(migration).not.toMatch(/^\s*TRUNCATE\b/im);
    expect(migration).not.toMatch(/\bDROP COLUMN\b/i);
  });

  it("creates the Stage 2 creative lineage tables", () => {
    for (const table of [
      "creative_runs",
      "creative_references",
      "creative_evaluations",
      "creative_experiments",
      "creative_experiment_runs",
    ]) {
      expect(migration).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`));
    }
  });

  it("links creative runs to existing execution records instead of replacing them", () => {
    expect(migration).toMatch(/agent_run_id UUID REFERENCES public\.agent_runs/);
    expect(migration).toMatch(/factory_job_id UUID REFERENCES public\.factory_jobs/);
    expect(migration).toMatch(/generation_id UUID REFERENCES public\.generations/);
  });

  it("extends canonical memory_items with evidence-backed learning", () => {
    expect(migration).toMatch(/ALTER TABLE public\.memory_items/);
    expect(migration).toMatch(/source_run_id UUID REFERENCES public\.creative_runs/);
    expect(migration).toMatch(/confidence NUMERIC\(5, 4\)/);
    expect(migration).toMatch(/evidence JSONB NOT NULL DEFAULT '\[\]'/);
  });

  it("enables RLS and keeps client writes server-side", () => {
    expect(migration).toMatch(/ALTER TABLE public\.creative_runs ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/CREATE POLICY creative_runs_select/);
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON public\.creative_runs FROM anon, authenticated/,
    );
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON public\.creative_experiments FROM anon, authenticated/,
    );
  });

  it("indexes run lineage and experiment membership", () => {
    expect(migration).toMatch(/idx_creative_runs_parent/);
    expect(migration).toMatch(/idx_creative_runs_project_created/);
    expect(migration).toMatch(/idx_creative_references_run_created/);
    expect(migration).toMatch(/idx_creative_evaluations_run_created/);
    expect(migration).toMatch(/idx_creative_experiment_runs_run/);
  });
});
