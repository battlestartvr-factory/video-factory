import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260817180500_stage3_queue_atomic_primitives.sql"),
  "utf-8",
);

describe("stage3 queue — pgmq contract", () => {
  it("repairs legacy workflow_kind compatibility before new queue paths", () => {
    expect(migration).toMatch(
      /ALTER COLUMN workflow_kind SET DEFAULT 'legacy_content'/,
    );
  });

  it("enables pgmq and creates one logged core queue idempotently", () => {
    expect(migration).toMatch(/CREATE EXTENSION IF NOT EXISTS pgmq/);
    expect(migration).toMatch(/FROM pgmq\.list_queues\(\)/);
    expect(migration).toContain("q.queue_name = 'core_orchestrator_v1'");
    expect(migration).toMatch(/PERFORM pgmq\.create\('core_orchestrator_v1'\)/);
    expect(migration).not.toMatch(/pgmq\.create_unlogged/);
  });

  it("uses read with visibility timeout and archive for at-least-once worker delivery", () => {
    expect(migration).toMatch(
      /pgmq\.read\('core_orchestrator_v1', p_visibility_seconds, p_qty\)/,
    );
    expect(migration).toMatch(
      /pgmq\.archive\('core_orchestrator_v1', p_msg_id\)/,
    );
    expect(migration).not.toMatch(/pgmq\.pop\(/);
  });

  it("keeps all public queue wrappers service-role only", () => {
    for (const fn of [
      "orchestrator_create_job",
      "orchestrator_enqueue",
      "orchestrator_read_queue",
      "orchestrator_archive_queue_message",
      "orchestrator_claim_job",
      "orchestrator_heartbeat_job",
      "orchestrator_finish_tick",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${fn}[\\s\\S]*?FROM PUBLIC, anon, authenticated;`,
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${fn}[\\s\\S]*?TO service_role;`,
        ),
      );
    }
  });
});

describe("stage3 queue — atomic job creation and wake", () => {
  it("uses request_id conflict handling before sending the first queue message", () => {
    const insertAt = migration.indexOf("ON CONFLICT (request_id) DO NOTHING");
    const sendAt = migration.indexOf("FROM pgmq.send(");
    expect(insertAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(insertAt);
    expect(migration).toContain("'reason', 'created'");
  });

  it("records queue message ids as workflow events", () => {
    expect(migration).toContain("'job.enqueued'");
    expect(migration).toContain("'queue:enqueued:' || v_msg_id::TEXT");
  });

  it("does not allow the Stage 3 creator to manufacture legacy content jobs", () => {
    expect(migration).toMatch(/v_workflow_kind = 'legacy_content'/);
    expect(migration).toContain("legacy_content must use factory_create_or_get_job");
  });
});

describe("stage3 leasing — fencing semantics", () => {
  it("claims under a row lock and generates a fresh UUID fencing token", () => {
    const claim = migration.match(
      /CREATE OR REPLACE FUNCTION public\.orchestrator_claim_job[\s\S]*?REVOKE ALL ON FUNCTION public\.orchestrator_claim_job/,
    )?.[0];
    expect(claim).toBeDefined();
    expect(claim).toMatch(/FOR UPDATE/);
    expect(claim).toMatch(/v_token := gen_random_uuid\(\)/);
    expect(claim).toMatch(/lease_token = v_token/);
    expect(claim).toMatch(/lease_expires_at = v_expires_at/);
  });

  it("refuses a second claimant while the current lease is alive", () => {
    expect(migration).toMatch(
      /v_job\.lease_expires_at > NOW\(\)[\s\S]*?'reason', 'leased'/,
    );
  });

  it("marks stale running work as recovered on the next claim", () => {
    expect(migration).toMatch(
      /v_recovered := v_job\.status = 'running' OR v_job\.lease_token IS NOT NULL/,
    );
    expect(migration).toContain("'job.recovered'");
  });

  it("never lets an expired lease heartbeat itself back to life", () => {
    const heartbeat = migration.match(
      /CREATE OR REPLACE FUNCTION public\.orchestrator_heartbeat_job[\s\S]*?REVOKE ALL ON FUNCTION public\.orchestrator_heartbeat_job/,
    )?.[0];
    expect(heartbeat).toBeDefined();
    expect(heartbeat).toMatch(/v_job\.lease_expires_at <= NOW\(\)/);
    expect(heartbeat).toContain("'lease_expired'");
  });

  it("renews DB lease and PGMQ visibility in the same RPC", () => {
    const heartbeat = migration.match(
      /CREATE OR REPLACE FUNCTION public\.orchestrator_heartbeat_job[\s\S]*?REVOKE ALL ON FUNCTION public\.orchestrator_heartbeat_job/,
    )?.[0];
    expect(heartbeat).toBeDefined();
    expect(heartbeat).toMatch(/pgmq\.set_vt\('core_orchestrator_v1'/);
    expect(heartbeat).toMatch(/lease_expires_at = v_expires_at/);
    expect(heartbeat).toMatch(/v_queue_message->>'job_id'/);
  });
});

describe("stage3 finish tick — durable transition semantics", () => {
  it("requires the current worker and fencing token for every committed tick", () => {
    const finish = migration.match(
      /CREATE OR REPLACE FUNCTION public\.orchestrator_finish_tick[\s\S]*?REVOKE ALL ON FUNCTION public\.orchestrator_finish_tick/,
    )?.[0];
    expect(finish).toBeDefined();
    expect(finish).toMatch(/v_job\.lease_owner IS DISTINCT FROM p_worker_id/);
    expect(finish).toMatch(/v_job\.lease_token IS DISTINCT FROM p_lease_token/);
    expect(finish).toMatch(/v_job\.lease_expires_at <= NOW\(\)/);
  });

  it("releases the lease after a stable state is committed", () => {
    const finish = migration.match(
      /CREATE OR REPLACE FUNCTION public\.orchestrator_finish_tick[\s\S]*?REVOKE ALL ON FUNCTION public\.orchestrator_finish_tick/,
    )?.[0];
    expect(finish).toBeDefined();
    expect(finish).toMatch(/lease_owner = NULL/);
    expect(finish).toMatch(/lease_token = NULL/);
    expect(finish).toMatch(/lease_expires_at = NULL/);
  });

  it("requires waiting and retrying states to have a recovery deadline", () => {
    expect(migration).toMatch(
      /p_new_status IN \('waiting', 'retrying'\) AND p_next_action_at IS NULL/,
    );
    expect(migration).toContain("requires next_action_at for durable recovery");
  });

  it("atomically schedules the next wake for queued, waiting and retrying states", () => {
    expect(migration).toMatch(
      /IF p_new_status IN \('queued', 'waiting', 'retrying'\) THEN[\s\S]*?pgmq\.send/,
    );
    expect(migration).toMatch(/SET last_enqueued_at = NOW\(\)/);
  });

  it("uses the consumed lease token as the transition-event dedupe identity", () => {
    expect(migration).toContain(
      "'job:transition:' || p_job_id::TEXT || ':' || p_lease_token::TEXT",
    );
  });
});
