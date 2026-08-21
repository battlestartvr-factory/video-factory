import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260821102000_research_fanout_queue_scoped_dedupe.sql"),
  "utf8",
);

describe("Research fan-out queue event dedupe", () => {
  it("scopes PGMQ message IDs by queue because msg_id is not globally unique", () => {
    expect(migration).toContain("'queue:research_orchestrator_v1:enqueued:' || v_msg_id::TEXT");
    expect(migration).not.toContain("'queue:enqueued:' || v_msg_id::TEXT");
    expect(migration).toContain("FROM pgmq.send(\n      'research_orchestrator_v1'");
  });
});
