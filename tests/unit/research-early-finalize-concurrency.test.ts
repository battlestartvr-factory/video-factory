import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const evidenceFenceMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260821101000_research_early_finalize_evidence_fence.sql"),
  "utf8",
);
const requestMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260821100000_research_early_finalize.sql"),
  "utf8",
);

describe("PR4 early-finalize concurrency fences", () => {
  it("serializes evidence writes with Scout terminalization", () => {
    expect(evidenceFenceMigration).toContain("FOR SHARE OF fj");
    expect(evidenceFenceMigration).toContain("v_cancel_reason = 'research_early_finalized'");
    expect(evidenceFenceMigration).toContain("RESEARCH_EARLY_FINALIZED: late Scout evidence rejected");
    expect(evidenceFenceMigration).toContain("v_job_status = 'cancelled'");
  });

  it("revokes any stale waiting-stage root lease before requeueing synthesis work", () => {
    expect(requestMigration).toContain("status = 'queued'");
    expect(requestMigration).toContain("lease_owner = NULL");
    expect(requestMigration).toContain("lease_token = NULL");
    expect(requestMigration).toContain("lease_expires_at = NULL");
    expect(requestMigration).toContain("last_heartbeat_at = NULL");
    expect(requestMigration).toContain("next_action_at = NOW()");
  });
});
