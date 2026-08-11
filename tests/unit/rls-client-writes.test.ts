import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const migrationsDir = join(process.cwd(), "supabase/migrations");

function readMigration(name: string): string {
  return readFileSync(join(migrationsDir, name), "utf-8");
}

const FORBIDDEN_CLIENT_POLICIES = [
  "jobs_update_client",
  "job_events_insert",
  "jobs_insert",
  "projects_insert",
  "projects_update",
  "project_members_insert",
  "reviews_insert",
];

describe("RLS migrations — restrict client writes", () => {
  const initial = readMigration("20260311000000_initial_schema.sql");
  const restrict = readMigration("20260311000002_restrict_client_writes.sql");

  it("initial migration does not grant client write policies on production tables", () => {
    for (const policy of FORBIDDEN_CLIENT_POLICIES) {
      expect(initial).not.toMatch(new RegExp(`CREATE POLICY ${policy}\\b`));
    }
  });

  it("restrict migration drops legacy client write policies", () => {
    for (const policy of FORBIDDEN_CLIENT_POLICIES) {
      expect(restrict).toMatch(new RegExp(`DROP POLICY IF EXISTS ${policy}`));
    }
  });

  it("initial migration keeps client SELECT policies", () => {
    expect(initial).toMatch(/CREATE POLICY jobs_select/);
    expect(initial).toMatch(/CREATE POLICY job_events_select/);
    expect(initial).toMatch(/CREATE POLICY profiles_update_self/);
  });

  it("SECURITY DEFINER helpers use safe search_path", () => {
    expect(initial).toMatch(
      /CREATE OR REPLACE FUNCTION public\.is_admin[\s\S]*SET search_path = public/,
    );
    expect(initial).toMatch(
      /CREATE OR REPLACE FUNCTION public\.has_project_access[\s\S]*SET search_path = public/,
    );
    expect(initial).toMatch(
      /CREATE OR REPLACE FUNCTION public\.can_edit_project[\s\S]*SET search_path = public/,
    );
    expect(initial).toMatch(
      /CREATE OR REPLACE FUNCTION public\.protect_profile_sensitive_fields[\s\S]*SET search_path = public/,
    );
  });

  it("helpers reference public schema tables", () => {
    expect(initial).toMatch(/FROM public\.profiles/);
    expect(initial).toMatch(/FROM public\.project_members/);
    expect(initial).toMatch(/FROM public\.jobs/);
  });
});

describe("RLS client write simulation", () => {
  it("authenticated user direct job update is denied without write policy", async () => {
    const rlsDenied = { error: { code: "42501", message: "permission denied" }, data: null };
    const userClient = {
      from: () => ({
        update: () => Promise.resolve(rlsDenied),
        insert: () => Promise.resolve(rlsDenied),
      }),
    };

    const [jobResult, eventResult] = await Promise.all([
      userClient.from("jobs").update({ status: "completed" }),
      userClient.from("job_events").insert({ job_id: "x", event_type: "fake" }),
    ]);

    expect(jobResult.error?.code).toBe("42501");
    expect(eventResult.error?.code).toBe("42501");
  });

  it("service role client bypasses RLS for writes", async () => {
    const serviceClient = {
      from: (_table: string) => ({
        update: (_payload: unknown) => Promise.resolve({ error: null, data: { status: "cancelled" } }),
        insert: (_payload: unknown) => Promise.resolve({ error: null, data: { id: "evt-1" } }),
      }),
    };

    const [jobResult, eventResult] = await Promise.all([
      serviceClient.from("jobs").update({ status: "cancelled" }),
      serviceClient.from("job_events").insert({ job_id: "x", event_type: "job.cancelled" }),
    ]);

    expect(jobResult.error).toBeNull();
    expect(eventResult.error).toBeNull();
  });
});
