import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260817181500_stage3_worker_runtime_primitives.sql"),
  "utf-8",
);

describe("stage3 worker runtime migration", () => {
  it("upserts worker heartbeats without using them as a lock", () => {
    expect(migration).toMatch(/INSERT INTO public\.orchestrator_workers/);
    expect(migration).toMatch(/ON CONFLICT \(worker_id\) DO UPDATE/);
    expect(migration).toMatch(/last_heartbeat_at = NOW\(\)/);
    expect(migration).not.toMatch(/FOR UPDATE/);
  });

  it("keeps worker heartbeat service-role only", () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.orchestrator_worker_heartbeat[\s\S]*FROM PUBLIC, anon, authenticated/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.orchestrator_worker_heartbeat[\s\S]*TO service_role/,
    );
  });
});
