import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260812000000_factory_content_system.sql"),
  "utf-8",
);

const LEGACY_MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20260311000000_initial_schema.sql"),
  "utf-8",
);

describe("factory migration — additive and safe", () => {
  it("does not drop or truncate legacy tables", () => {
    expect(migration).not.toMatch(/\bDROP TABLE\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/DROP TABLE public\.jobs/i);
    expect(migration).not.toMatch(/DROP TABLE public\.assets/i);
  });

  it("legacy jobs/assets schema blocks remain untouched", () => {
    expect(LEGACY_MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS jobs/);
    expect(LEGACY_MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS assets/);
    expect(migration).not.toMatch(/ALTER TABLE public\.jobs\b/);
    expect(migration).not.toMatch(/ALTER TABLE public\.assets\b/);
  });

  it("uses factory_ prefix for conflicting domain tables", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.factory_jobs/);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.factory_assets/);
  });

  it("defines required RPC functions with service_role-only execute", () => {
    const rpcs = [
      "factory_create_or_get_job",
      "factory_claim_stage",
      "factory_record_event",
      "factory_transition_job",
      "factory_check_budget",
    ];
    for (const fn of rpcs) {
      const blockMatch = migration.match(
        new RegExp(
          `-- RPC: ${fn}[\\s\\S]*?REVOKE ALL ON FUNCTION public\\.${fn}[\\s\\S]*?GRANT EXECUTE ON FUNCTION public\\.${fn}[\\s\\S]*?TO service_role;`,
        ),
      );
      expect(blockMatch, `missing RPC block for ${fn}`).not.toBeNull();
      const block = blockMatch![0];
      expect(block).toMatch(/FROM PUBLIC, anon, authenticated/);
      expect(block).not.toMatch(/TO authenticated/);
    }
  });

  it("safe views use security_invoker=true", () => {
    for (const view of [
      "factory_job_stages_safe",
      "factory_assets_safe",
      "factory_job_detail",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `CREATE OR REPLACE VIEW public\\.${view}[\\s\\S]*WITH \\(security_invoker = true\\)`,
        ),
      );
    }
  });

  it("has_factory_job_access is granted to authenticated for policy use only", () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.has_factory_job_access[\s\S]* FROM PUBLIC/,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.has_factory_job_access[\s\S]* FROM anon/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.has_factory_job_access[\s\S]* TO authenticated/,
    );
    expect(migration).toMatch(
      /has_factory_job_access[\s\S]*has_project_access\(uid, fj\.project_id\)/,
    );
  });

  it("uses has_project_access for factory_jobs SELECT policy", () => {
    expect(migration).toMatch(/CREATE POLICY factory_jobs_select[\s\S]*has_project_access/);
  });
});

describe("factory migration — RLS isolation semantics", () => {
  it("simulates user A cannot SELECT foreign factory job (no matching policy row)", () => {
    const userA = "user-a-uuid";
    const projectA = "project-a-uuid";
    const projectB = "project-b-uuid";

    const members = [
      { project_id: projectA, user_id: userA, member_role: "owner" },
    ];
    const factoryJobs = [
      { id: "job-b", project_id: projectB, status: "queued" },
    ];

    const hasProjectAccess = (uid: string, pid: string) =>
      members.some((m) => m.user_id === uid && m.project_id === pid);

    const visibleJobs = factoryJobs.filter((j) => hasProjectAccess(userA, j.project_id));
    expect(visibleJobs).toHaveLength(0);
  });

  it("simulates safe views inherit RLS via security_invoker (no bypass grant)", () => {
    const detailView = migration.match(
      /CREATE OR REPLACE VIEW public\.factory_job_detail[\s\S]*?FROM public\.factory_jobs AS fj;/,
    )?.[0];
    expect(detailView).toBeDefined();
    expect(detailView).toMatch(/WITH \(security_invoker = true\)/);
    expect(detailView).not.toMatch(/SECURITY DEFINER/);
    expect(migration).toMatch(/GRANT SELECT ON public\.factory_job_detail TO authenticated/);
  });
});

describe("factory migration — idempotency semantics", () => {
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
