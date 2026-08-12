import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260812000000_factory_content_system.sql"),
  "utf-8",
);

describe("factory migration — additive and safe", () => {
  it("does not drop or truncate legacy tables", () => {
    expect(migration).not.toMatch(/\bDROP TABLE\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/DROP TABLE public\.jobs/i);
    expect(migration).not.toMatch(/DROP TABLE public\.assets/i);
  });

  it("uses factory_ prefix for conflicting domain tables", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.factory_jobs/);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.factory_assets/);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.factory_job_stages/);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.factory_approvals/);
  });

  it("adds projects.factory_settings additively", () => {
    expect(migration).toMatch(
      /ALTER TABLE public\.projects[\s\S]*ADD COLUMN IF NOT EXISTS factory_settings/,
    );
  });

  it("defines required RPC functions with service_role grants", () => {
    const rpcs = [
      "factory_create_or_get_job",
      "factory_claim_stage",
      "factory_record_event",
      "factory_transition_job",
      "factory_check_budget",
    ];
    for (const fn of rpcs) {
      expect(migration).toMatch(new RegExp(`FUNCTION public\\.${fn}`));
      expect(migration).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}[\\s\\S]* TO service_role`),
      );
      expect(migration).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}[\\s\\S]* FROM PUBLIC`),
      );
    }
  });

  it("enables RLS on all new factory tables", () => {
    const tables = [
      "factory_jobs",
      "factory_job_stages",
      "factory_assets",
      "factory_approvals",
      "factory_workflow_events",
      "factory_cost_events",
      "provider_models",
      "provider_tasks",
    ];
    for (const table of tables) {
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`),
      );
    }
  });

  it("does not create permissive authenticated policies on server-only tables", () => {
    expect(migration).not.toMatch(
      /CREATE POLICY[\s\S]*ON public\.provider_tasks[\s\S]*USING \(true\)/,
    );
    expect(migration).not.toMatch(
      /CREATE POLICY[\s\S]*ON public\.factory_workflow_events[\s\S]*FOR SELECT/,
    );
  });

  it("includes ai_game_lab disclosure constraint", () => {
    expect(migration).toMatch(/factory_jobs_ai_game_lab_disclosure_check/);
  });

  it("includes asset storage CHECK constraints", () => {
    expect(migration).toMatch(/factory_assets_b2_fields_check/);
    expect(migration).toMatch(/factory_assets_drive_fields_check/);
    expect(migration).toMatch(/factory_assets_inline_fields_check/);
  });

  it("reuses set_updated_at trigger function", () => {
    expect(migration).toMatch(/EXECUTE FUNCTION public\.set_updated_at\(\)/);
  });

  it("creates safe views without provider payloads", () => {
    expect(migration).toMatch(/CREATE OR REPLACE VIEW public\.factory_job_stages_safe/);
    expect(migration).toMatch(/CREATE OR REPLACE VIEW public\.factory_assets_safe/);
    expect(migration).toMatch(/CREATE OR REPLACE VIEW public\.factory_job_detail/);
  });

  it("uses has_project_access for factory_jobs SELECT policy", () => {
    expect(migration).toMatch(/CREATE POLICY factory_jobs_select[\s\S]*has_project_access/);
  });
});

describe("factory migration — idempotency semantics (documentation)", () => {
  it("documents duplicate request_id via ON CONFLICT on request_id", () => {
    expect(migration).toMatch(/ON CONFLICT \(request_id\) DO NOTHING/);
  });

  it("documents duplicate events via ON CONFLICT on dedupe_key", () => {
    expect(migration).toMatch(/ON CONFLICT \(dedupe_key\) DO NOTHING/);
  });

  it("documents terminal immutability in factory_transition_job", () => {
    expect(migration).toMatch(/terminal_immutable/);
  });
});
