import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function repoFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("security and release hardening contracts", () => {
  it("keeps public-schema client grants least-privilege by default", () => {
    const migration = repoFile(
      "supabase/migrations/20260822193300_security_and_release_acceptance_hardening.sql",
    );

    expect(migration).toContain(
      "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon",
    );
    expect(migration).toContain(
      "REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM authenticated",
    );
    expect(migration).toContain(
      "REVOKE ALL PRIVILEGES ON TABLES FROM anon, authenticated",
    );
    expect(migration).toContain(
      "REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon, authenticated",
    );
    expect(migration).toContain("orchestrator_release_worker_ready");
    expect(migration).toContain("TO service_role");
    expect(migration).toContain("schema_version = '20260822193300'");
  });

  it("requires both worker containers and fresh exact-release heartbeats", () => {
    const deploy = repoFile("scripts/deploy.sh");

    expect(deploy).toContain("ps research-worker --status running --services");
    expect(deploy).toContain('release_worker_ready "core"');
    expect(deploy).toContain('release_worker_ready "research"');
    expect(deploy).toContain("WORKER_HEARTBEAT_NOT_BEFORE");
    expect(deploy).toContain("orchestrator_release_worker_ready");
    expect(deploy).toContain("mock_workflows=false");
  });
});
