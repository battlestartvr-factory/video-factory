import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260814120000_universal_agent.sql"),
  "utf-8",
);

describe("universal agent migration — additive and safe", () => {
  it("does not drop or truncate tables", () => {
    expect(migration).not.toMatch(/\bDROP TABLE\b/i);
    expect(migration).not.toMatch(/^\s*TRUNCATE\b/im);
    expect(migration).not.toMatch(/\bDROP COLUMN\b/i);
  });

  it("does not modify factory orchestration tables", () => {
    expect(migration).not.toMatch(/ALTER TABLE public\.factory_jobs\b/);
    expect(migration).not.toMatch(/ALTER TABLE public\.provider_tasks\b/);
    expect(migration).not.toMatch(/ALTER TABLE public\.generations\b/);
  });

  it("creates agent audit tables", () => {
    for (const table of ["agent_runs", "agent_tool_runs", "agent_actions"]) {
      expect(migration).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`));
    }
  });

  it("enables RLS and revokes client writes", () => {
    expect(migration).toMatch(/ALTER TABLE public\.agent_runs ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON public\.agent_runs FROM anon, authenticated/,
    );
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON public\.agent_actions FROM anon, authenticated/,
    );
  });

  it("indexes foreign keys", () => {
    expect(migration).toMatch(/idx_agent_runs_chat_started/);
    expect(migration).toMatch(/idx_agent_tool_runs_run_started/);
    expect(migration).toMatch(/idx_agent_actions_generation/);
  });
});
