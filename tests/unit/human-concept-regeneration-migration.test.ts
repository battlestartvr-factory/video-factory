import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260821155448_fix_human_concept_regeneration_persistence.sql",
  ),
  "utf-8",
);

describe("human concept regeneration persistence migration", () => {
  it("repairs the obsolete workflow event conflict target", () => {
    expect(migration).toContain("'ON CONFLICT (dedupe_key) DO NOTHING'");
    expect(migration).toContain("obsolete workflow event conflict target is still present");
  });

  it("makes concept persistence event keys job-scoped", () => {
    expect(migration).toContain("'stage4:s4-003:concepts-persisted:'");
    expect(migration).toContain("v_job_id::TEXT");
    expect(migration).toContain("concept persistence event key is not job-scoped");
  });

  it("advances the deploy schema fence to the production migration version", () => {
    expect(migration).toContain("deployment_schema_contract");
    expect(migration).toContain("20260821155448");
  });
});
