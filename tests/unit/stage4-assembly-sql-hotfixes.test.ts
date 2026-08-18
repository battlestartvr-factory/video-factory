import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const assemblyPersistMigration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260818192253_fix_stage4_assembly_dedupe_operator_precedence.sql",
  ),
  "utf-8",
);

const finalizationMigration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260818192457_fix_stage4_finalization_jsonb_object_count.sql",
  ),
  "utf-8",
);

describe("Stage 4 assembly SQL hotfixes", () => {
  it("builds the assembly event dedupe key without JSON operator precedence ambiguity", () => {
    expect(assemblyPersistMigration).toMatch(
      /format\('stage4:prototype-assembly:%s:%s', v_concept_run_id::TEXT, v_assembly->>'sha256'\)/,
    );
    expect(assemblyPersistMigration).not.toMatch(
      /v_concept_run_id::TEXT \|\| ':' \|\| v_assembly->>'sha256'/,
    );
  });

  it("counts JSON object entries via jsonb_object_keys rather than a nonexistent helper", () => {
    expect(finalizationMigration).toMatch(/FROM jsonb_object_keys\(/);
    expect(finalizationMigration).not.toMatch(/jsonb_object_length\(/);
  });
});
