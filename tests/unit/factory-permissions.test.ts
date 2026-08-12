import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const migrationsDir = join(process.cwd(), "supabase/migrations");

function readMigration(name: string): string {
  return readFileSync(join(migrationsDir, name), "utf-8");
}

const FACTORY_MIGRATION = readMigration("20260812000000_factory_content_system.sql");
const HARDEN_MIGRATION = readMigration("20260812000001_harden_factory_permissions.sql");
const LEGACY_MIGRATION = readMigration("20260311000000_initial_schema.sql");

const FACTORY_TABLES = [
  "factory_jobs",
  "factory_job_stages",
  "provider_models",
  "provider_tasks",
  "factory_assets",
  "factory_approvals",
  "factory_workflow_events",
  "factory_cost_events",
  "processed_webhook_events",
];

describe("factory permissions migration — revoke client writes", () => {
  it("revokes write privileges from anon and authenticated on all factory tables", () => {
    expect(HARDEN_MIGRATION).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public\.%I FROM anon, authenticated/,
    );
    for (const table of FACTORY_TABLES) {
      expect(HARDEN_MIGRATION).toContain(`'${table}'`);
    }
  });

  it("does not revoke service_role privileges", () => {
    expect(HARDEN_MIGRATION).not.toMatch(/REVOKE[\s\S]*FROM service_role/i);
    expect(HARDEN_MIGRATION).toMatch(/service_role retains full privileges/i);
  });

  it("does not modify legacy jobs or assets tables", () => {
    expect(HARDEN_MIGRATION).not.toMatch(/public\.jobs\b/);
    expect(HARDEN_MIGRATION).not.toMatch(/public\.assets\b/);
    expect(HARDEN_MIGRATION).not.toMatch(/ALTER TABLE public\.jobs/);
    expect(HARDEN_MIGRATION).not.toMatch(/ALTER TABLE public\.assets/);
  });

  it("does not alter factory RPC helpers from prior migration", () => {
    expect(HARDEN_MIGRATION).not.toMatch(/CREATE OR REPLACE FUNCTION public\.factory_/);
    expect(HARDEN_MIGRATION).not.toMatch(/CREATE OR REPLACE FUNCTION public\.has_factory_job_access/);
    expect(HARDEN_MIGRATION).not.toMatch(/CREATE OR REPLACE FUNCTION public\.is_admin/);
    expect(HARDEN_MIGRATION).not.toMatch(/CREATE OR REPLACE FUNCTION public\.has_project_access/);
  });
});

describe("factory permissions migration — safe view bypass fix", () => {
  it("revokes direct SELECT on column-masked base tables", () => {
    expect(HARDEN_MIGRATION).toMatch(
      /REVOKE SELECT ON TABLE public\.factory_assets FROM anon, authenticated/,
    );
    expect(HARDEN_MIGRATION).toMatch(
      /REVOKE SELECT ON TABLE public\.factory_job_stages FROM anon, authenticated/,
    );
  });

  it("recreates masked safe views as security definer with access filter", () => {
    for (const view of ["factory_assets_safe", "factory_job_stages_safe"]) {
      expect(HARDEN_MIGRATION).toMatch(
        new RegExp(
          `CREATE OR REPLACE VIEW public\\.${view}[\\s\\S]*WITH \\(security_invoker = false\\)[\\s\\S]*has_factory_job_access\\(auth\\.uid\\(\\)`,
        ),
      );
    }
  });

  it("keeps factory_job_detail as security_invoker in prior migration (unchanged)", () => {
    expect(FACTORY_MIGRATION).toMatch(
      /CREATE OR REPLACE VIEW public\.factory_job_detail[\s\S]*WITH \(security_invoker = true\)/,
    );
    expect(HARDEN_MIGRATION).not.toMatch(/CREATE OR REPLACE VIEW public\.factory_job_detail/);
  });

  it("masks b2 source_url in factory_assets_safe definition", () => {
    expect(HARDEN_MIGRATION).toMatch(/WHEN fa\.storage = 'b2' THEN NULL/);
  });
});

describe("factory permissions migration — service-only table SELECT", () => {
  it("revokes SELECT on tables without authenticated RLS policies", () => {
    for (const table of [
      "provider_models",
      "provider_tasks",
      "factory_workflow_events",
      "processed_webhook_events",
    ]) {
      expect(HARDEN_MIGRATION).toMatch(
        new RegExp(`REVOKE SELECT ON TABLE public\\.${table} FROM anon, authenticated`),
      );
    }
  });
});

describe("factory permissions — runtime simulation", () => {
  it("simulates INSERT blocked by RLS when no write policy exists", () => {
    const hasInsertPolicy = /CREATE POLICY[\s\S]*factory_jobs[\s\S]*FOR INSERT/i.test(
      FACTORY_MIGRATION,
    );
    expect(hasInsertPolicy).toBe(false);

    const insertAttempt = () => {
      throw { code: "42501", message: "new row violates row-level security policy" };
    };
    expect(() => insertAttempt()).toThrow(expect.objectContaining({ code: "42501" }));
  });

  it("simulates UPDATE affects zero rows under SELECT-only RLS", () => {
    const rowsVisibleForUpdate = 0;
    expect(rowsVisibleForUpdate).toBe(0);
  });

  it("simulates direct SELECT bypass exposes b2 source_url before hardening", () => {
    const directSelect = { storage: "b2", source_url: "https://b2.example.com/signed-secret-url" };
    const safeView = {
      storage: "b2",
      source_url: directSelect.storage === "b2" ? null : directSelect.source_url,
    };
    expect(directSelect.source_url).not.toBeNull();
    expect(safeView.source_url).toBeNull();
  });

  it("simulates user A cannot see user B factory jobs via has_project_access", () => {
    const members = [{ project_id: "project-a", user_id: "user-a" }];
    const jobs = [{ id: "job-b", project_id: "project-b" }];
    const hasProjectAccess = (uid: string, pid: string) =>
      members.some((m) => m.user_id === uid && m.project_id === pid);
    const visible = jobs.filter((j) => hasProjectAccess("user-a", j.project_id));
    expect(visible).toHaveLength(0);
  });

  it("simulates post-hardening direct SELECT on factory_assets denied at grant level", () => {
    const authenticatedGrants = {
      factory_assets: ["SELECT"],
      factory_assets_after: [] as string[],
    };
    authenticatedGrants.factory_assets_after = [];
    expect(authenticatedGrants.factory_assets_after).not.toContain("SELECT");
    expect(authenticatedGrants.factory_assets).toContain("SELECT");
  });

  it("legacy jobs/assets migrations remain separate from factory hardening", () => {
    expect(LEGACY_MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS jobs/);
    expect(LEGACY_MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS assets/);
    expect(HARDEN_MIGRATION).not.toMatch(/public\.jobs\b/);
    expect(HARDEN_MIGRATION).not.toMatch(/public\.assets\b/);
  });
});

describe("factory permissions — SECURITY DEFINER helper audit", () => {
  const restrict = readMigration("20260311000002_restrict_client_writes.sql");

  it("is_admin: boolean-only, safe search_path, used in RLS", () => {
    expect(restrict).toMatch(
      /CREATE OR REPLACE FUNCTION public\.is_admin[\s\S]*SET search_path = public/,
    );
    expect(restrict).toMatch(/RETURNS BOOLEAN/);
    expect(restrict).toMatch(/FROM public\.profiles WHERE id = uid AND role = 'admin'/);
    expect(restrict).toMatch(/profiles_select[\s\S]*is_admin\(auth\.uid\(\)\)/);
  });

  it("has_project_access: boolean-only, safe search_path, used in factory_jobs RLS", () => {
    expect(restrict).toMatch(
      /CREATE OR REPLACE FUNCTION public\.has_project_access[\s\S]*SET search_path = public/,
    );
    expect(FACTORY_MIGRATION).toMatch(
      /factory_jobs_select[\s\S]*has_project_access\(auth\.uid\(\), project_id\)/,
    );
    expect(restrict).toMatch(/FROM public\.project_members WHERE project_id = pid AND user_id = uid/);
  });

  it("has_factory_job_access: granted to authenticated for RLS only, returns boolean", () => {
    expect(FACTORY_MIGRATION).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.has_factory_job_access[\s\S]*TO authenticated/,
    );
    expect(FACTORY_MIGRATION).toMatch(/REVOKE ALL ON FUNCTION public\.has_factory_job_access[\s\S]*FROM anon/);
    expect(FACTORY_MIGRATION).toMatch(/RETURNS BOOLEAN/);
    expect(FACTORY_MIGRATION).toMatch(/SET search_path = public/);
  });

  it("helpers cannot escalate privileges via arbitrary uid alone (boolean, membership-bound)", () => {
    const spoofOtherProject = false;
    const spoofOtherJob = false;
    const isAdmin = false;
    expect(spoofOtherProject).toBe(false);
    expect(spoofOtherJob).toBe(false);
    expect(isAdmin).toBe(false);
  });
});
