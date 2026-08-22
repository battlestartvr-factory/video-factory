import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260822084500_allow_v3_research_progress.sql"),
  "utf8",
);

describe("Game Discovery v3 research progress compatibility migration", () => {
  it("accepts v2 and v3 discovery roots without opening the RPC to clients", () => {
    expect(migration).toContain("fj.workflow_version IN (2, 3)");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.research_record_progress_event(JSONB)");
    expect(migration).toContain("FROM PUBLIC, anon, authenticated");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.research_record_progress_event(JSONB) TO service_role");
  });

  it("advances the production schema fence", () => {
    expect(migration).toContain("schema_version = '20260822084500'");
  });
});
