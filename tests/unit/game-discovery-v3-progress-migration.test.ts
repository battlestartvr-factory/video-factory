import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const compatibilityMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260822084500_allow_v3_research_progress.sql"),
  "utf8",
);
const regexMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260822090000_fix_research_progress_event_regex.sql"),
  "utf8",
);

describe("Game Discovery v3 research progress compatibility migrations", () => {
  it("accepts v2 and v3 discovery roots without opening the RPC to clients", () => {
    expect(compatibilityMigration).toContain("fj.workflow_version IN (2, 3)");
    expect(regexMigration).toContain("fj.workflow_version IN (2, 3)");
    expect(regexMigration).toContain("REVOKE ALL ON FUNCTION public.research_record_progress_event(JSONB)");
    expect(regexMigration).toContain("FROM PUBLIC, anon, authenticated");
    expect(regexMigration).toContain("GRANT EXECUTE ON FUNCTION public.research_record_progress_event(JSONB) TO service_role");
  });

  it("uses an unambiguous literal-dot namespace guard for valid research events", () => {
    expect(regexMigration).toContain("v_event_type !~ '^(research|concept|job)[.]'");
    expect(regexMigration).not.toContain("v_event_type !~ '^(research|concept|job)\\\\.'");
  });

  it("advances the production schema fence", () => {
    expect(regexMigration).toContain("schema_version = '20260822090000'");
  });
});
