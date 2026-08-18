import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DurableWorkflowError,
  computeRetryDelayMs,
  normalizeWorkflowError,
  shouldRetry,
} from "@/lib/orchestrator/retry";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260817181500_stage3_retry_recovery_watchdog.sql"),
  "utf-8",
);

describe("stage3 durable retry policy", () => {
  it("does not retry unknown/programming errors by default", () => {
    const error = normalizeWorkflowError(new Error("boom"));
    expect(error.retryable).toBe(false);
    expect(shouldRetry({ retryable: error.retryable, retryCount: 0, maxAttempts: 5 })).toBe(false);
  });

  it("retries explicitly classified transient failures while attempts remain", () => {
    const error = normalizeWorkflowError(
      new DurableWorkflowError({ code: "PROVIDER_TEMPORARY", message: "try again", retryable: true }),
    );
    expect(error.retryable).toBe(true);
    expect(shouldRetry({ retryable: true, retryCount: 0, maxAttempts: 5 })).toBe(true);
    expect(shouldRetry({ retryable: true, retryCount: 4, maxAttempts: 5 })).toBe(false);
  });

  it("uses retry-after when supplied", () => {
    expect(computeRetryDelayMs({ retryCount: 0, retryAfterMs: 12_345 })).toBe(12_345);
  });

  it("applies bounded jitter to exponential backoff", () => {
    expect(computeRetryDelayMs({ retryCount: 0, random: () => 0 })).toBe(4_000);
    expect(computeRetryDelayMs({ retryCount: 0, random: () => 1 })).toBe(6_000);
    expect(computeRetryDelayMs({ retryCount: 1, random: () => 0.5 })).toBe(20_000);
  });
});

describe("stage3 watchdog migration", () => {
  it("persists a nonnegative retry count and returns it from claim", () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0/);
    expect(migration).toMatch(/factory_jobs_retry_count_nonnegative/);
    expect(migration).toMatch(/'retry_count', v_job\.retry_count/);
  });

  it("increments retry_count only when entering retrying", () => {
    expect(migration).toMatch(
      /v_retry_count := v_job\.retry_count \+ CASE WHEN p_new_status = 'retrying' THEN 1 ELSE 0 END/,
    );
  });

  it("watchdog locks candidates with SKIP LOCKED and repairs stale running work", () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.orchestrator_watchdog_recover/);
    expect(migration).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(migration).toMatch(/fj\.status = 'running'/);
    expect(migration).toMatch(/fj\.lease_expires_at <= NOW\(\)/);
    expect(migration).toMatch(/status = 'interrupted'/);
    expect(migration).toMatch(/state_reason = 'watchdog_stale_lease'/);
  });

  it("watchdog reconstructs PGMQ wake-ups and is service-role only", () => {
    expect(migration).toMatch(/pgmq\.send\(/);
    expect(migration).toMatch(/'reason', CASE WHEN v_job\.status = 'running' THEN 'stale_lease' ELSE 'watchdog' END/);
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.orchestrator_watchdog_recover\(INTEGER, INTEGER\)[\s\S]*FROM PUBLIC, anon, authenticated/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.orchestrator_watchdog_recover\(INTEGER, INTEGER\)[\s\S]*TO service_role/,
    );
  });
});
