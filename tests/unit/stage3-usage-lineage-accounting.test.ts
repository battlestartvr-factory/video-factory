import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260817184500_stage3_usage_lineage_accounting.sql",
  ),
  "utf8",
);

describe("Stage 3 provider usage + lineage accounting migration", () => {
  it("persists dated pricing evidence before paid execution", () => {
    expect(sql).toContain("estimated_cost_usd NUMERIC(12, 6)");
    expect(sql).toContain("pricing_snapshot JSONB");
    expect(sql).toContain("provider_tasks_apply_pricing_snapshot");
    expect(sql).toContain("public_list_price_estimate");
    expect(sql).toContain("snapshot_date");
  });

  it("keeps one deduped cost event per provider task and carries credits", () => {
    expect(sql).toContain("'provider:cost:' || NEW.id::TEXT");
    expect(sql).toContain("ON CONFLICT (dedupe_key) DO UPDATE");
    expect(sql).toContain("NEW.credits_used");
    expect(sql).toContain("actual_cost_usd = v_job_actual_cost");
  });

  it("late-binds creative lineage across stages, tasks, events and costs", () => {
    expect(sql).toContain("orchestrator_attach_creative_run_to_generation");
    expect(sql).toContain("UPDATE public.factory_job_stages");
    expect(sql).toContain("UPDATE public.provider_tasks");
    expect(sql).toContain("UPDATE public.factory_workflow_events");
    expect(sql).toContain("UPDATE public.factory_cost_events");
    expect(sql).toContain("creative_runs_auto_attach_durable_lineage");
  });

  it("does not expose repair/accounting RPCs to browser roles", () => {
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.orchestrator_attach_creative_run_to_generation(UUID, UUID)",
    );
    expect(sql).toContain("FROM PUBLIC, anon, authenticated");
    expect(sql).toContain("TO service_role");
  });
});
