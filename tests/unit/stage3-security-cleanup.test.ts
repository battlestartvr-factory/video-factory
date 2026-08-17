import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260817184600_stage3_security_cleanup.sql"),
  "utf8",
);

describe("Stage 3 legacy security cleanup", () => {
  it("removes browser RPC execution from trigger-only security definer functions", () => {
    expect(sql).toContain("public.handle_new_user()");
    expect(sql).toContain("public.protect_profile_sensitive_fields()");
    expect(sql.match(/FROM PUBLIC, anon, authenticated/g)?.length).toBe(2);
  });

  it("pins the knowledge search helper search_path", () => {
    expect(sql).toContain("public.search_knowledge_chunks(UUID[], TEXT, INTEGER)");
    expect(sql).toContain("SET search_path = public");
  });
});
