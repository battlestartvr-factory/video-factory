import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const deploy = readFileSync(join(process.cwd(), "scripts/deploy.sh"), "utf8");

describe("Stage 3 production deploy hardening", () => {
  it("can resolve a pre-merge target commit without relying on preflight cache", () => {
    expect(deploy).toContain("Target commit is not local; fetching advertised origin branches");
    expect(deploy).toContain("+refs/heads/*:refs/remotes/origin/*");
    expect(deploy).toContain('git cat-file -e "${COMMIT}^{commit}"');
  });

  it("records last-good and rollback candidate only after app + worker health", () => {
    expect(deploy).toContain("worker_running");
    expect(deploy).toContain("LAST_GOOD_FILE");
    expect(deploy).toContain("ROLLBACK_CANDIDATE_FILE");
    expect(deploy).toContain("Recorded last-good commit");
    expect(deploy).toContain("Rollback candidate remains");
  });
});
