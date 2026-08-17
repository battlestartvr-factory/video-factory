import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260817180000_stage3_durable_core_schema.sql"),
  "utf-8",
);

describe("stage3 durable schema — additive compatibility", () => {
  it("does not drop factory tables or truncate data", () => {
    expect(migration).not.toMatch(/\bDROP TABLE\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("backfills existing jobs as legacy_content before workflow_kind becomes required", () => {
    const backfill = migration.indexOf("SET workflow_kind = 'legacy_content'");
    const notNull = migration.indexOf("ALTER COLUMN workflow_kind SET NOT NULL");
    expect(backfill).toBeGreaterThan(-1);
    expect(notNull).toBeGreaterThan(backfill);
  });

  it("makes content-era fields optional while preserving the legacy contract", () => {
    for (const column of ["project_id", "job_type", "preset", "content_namespace"]) {
      expect(migration).toContain(`ALTER COLUMN ${column} DROP NOT NULL`);
    }
    expect(migration).toMatch(/factory_jobs_legacy_contract_check/);
    expect(migration).toMatch(/workflow_kind <> 'legacy_content'/);
  });
});

describe("stage3 durable schema — job state and leases", () => {
  it("persists workflow identity, scheduler state, lease and retry lineage", () => {
    for (const field of [
      "workflow_kind",
      "workflow_version",
      "state JSONB",
      "next_action_at",
      "last_enqueued_at",
      "lease_owner",
      "lease_token",
      "lease_expires_at",
      "last_heartbeat_at",
      "state_reason",
      "retry_of_job_id",
    ]) {
      expect(migration).toContain(field);
    }
  });

  it("supports waiting/retrying and terminal durable job states", () => {
    for (const status of [
      "queued",
      "running",
      "waiting",
      "awaiting_approval",
      "retrying",
      "completed",
      "failed",
      "cancelled",
    ]) {
      expect(migration).toContain(`'${status}'`);
    }
  });

  it("requires a complete lease tuple so partial leases cannot be persisted", () => {
    expect(migration).toMatch(/factory_jobs_lease_consistency_check/);
    expect(migration).toMatch(
      /lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL/,
    );
    expect(migration).toMatch(
      /lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL/,
    );
  });

  it("adds indexes needed by watchdog and stale-lease recovery", () => {
    expect(migration).toMatch(/idx_factory_jobs_due/);
    expect(migration).toMatch(/idx_factory_jobs_lease_expiry/);
  });
});

describe("stage3 durable schema — attempts and provider tasks", () => {
  it("adds interrupted stage attempts and direct creative lineage", () => {
    expect(migration).toContain("'interrupted'");
    expect(migration).toMatch(/factory_job_stages_creative_run_id_fkey/);
  });

  it("supports submit uncertainty and provider reconciliation", () => {
    for (const status of ["submitting", "submitted", "processing", "reconciling"]) {
      expect(migration).toContain(`'${status}'`);
    }
    for (const field of [
      "submission_attempts",
      "next_check_at",
      "callback_token",
      "callback_received_at",
      "request_payload_hash",
      "response_payload_hash",
    ]) {
      expect(migration).toContain(field);
    }
    expect(migration).toMatch(/idx_provider_tasks_due_check/);
  });
});

describe("stage3 durable schema — idempotency and observability", () => {
  it("makes cost events idempotent with a unique dedupe key", () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS dedupe_key TEXT/);
    expect(migration).toMatch(/SET dedupe_key = 'legacy:' \|\| id::TEXT/);
    expect(migration).toMatch(/factory_cost_events_dedupe_key_key UNIQUE \(dedupe_key\)/);
  });

  it("links provider tasks, events and costs directly to creative lineage", () => {
    expect(migration).toMatch(/provider_tasks_creative_run_id_fkey/);
    expect(migration).toMatch(/factory_workflow_events_creative_run_id_fkey/);
    expect(migration).toMatch(/factory_cost_events_creative_run_id_fkey/);
  });

  it("adds service-only worker heartbeat records", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.orchestrator_workers/);
    expect(migration).toMatch(/last_heartbeat_at TIMESTAMPTZ NOT NULL/);
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.orchestrator_workers FROM anon, authenticated/,
    );
  });
});

describe("stage3 durable schema — project-less access", () => {
  it("allows an owner to read a studio-level job with no project", () => {
    expect(migration).toMatch(/fj\.user_id = uid/);
    expect(migration).toMatch(/fj\.project_id IS NOT NULL[\s\S]*has_project_access\(uid, fj\.project_id\)/);
    expect(migration).toMatch(/user_id = \(SELECT auth\.uid\(\)\)/);
  });

  it("does not expose lease owner/token/expiry in factory_job_detail", () => {
    const view = migration.match(
      /CREATE OR REPLACE VIEW public\.factory_job_detail[\s\S]*?FROM public\.factory_jobs AS fj;/,
    )?.[0];
    expect(view).toBeDefined();
    expect(view).not.toMatch(/fj\.lease_owner/);
    expect(view).not.toMatch(/fj\.lease_token/);
    expect(view).not.toMatch(/fj\.lease_expires_at/);
    expect(view).toMatch(/fj\.workflow_kind/);
    expect(view).toMatch(/fj\.next_action_at/);
  });
});
