import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = join(process.cwd(), "supabase/migrations");

function latestMigrationContaining(fragment: string) {
  const matches = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => ({
      file,
      source: readFileSync(join(migrationsDir, file), "utf8"),
    }))
    .filter(({ source }) => source.includes(fragment));

  expect(matches.length).toBeGreaterThan(0);
  return matches[matches.length - 1]!;
}

describe("latest durable parked-waiting SQL contract", () => {
  it("keeps timerless human waiting valid after queue-aware finish routing", () => {
    const latest = latestMigrationContaining(
      "CREATE OR REPLACE FUNCTION public.orchestrator_finish_tick",
    );

    expect(latest.file).toBe("20260821142000_restore_queue_aware_parked_waiting.sql");
    expect(latest.source).toContain("orchestrator_queue_name_for_workflow");
    expect(latest.source).toMatch(
      /IF p_new_status = 'retrying' AND p_next_action_at IS NULL THEN/,
    );
    expect(latest.source).not.toMatch(
      /IF p_new_status IN \('waiting', 'retrying'\) AND p_next_action_at IS NULL THEN/,
    );
    expect(latest.source).toMatch(
      /p_new_status = 'queued'[\s\S]*OR \(p_new_status IN \('waiting', 'retrying'\) AND v_effective_next_action IS NOT NULL\)/,
    );
  });

  it("never watchdog-enqueues timerless parked waiting after queue routing", () => {
    const latest = latestMigrationContaining(
      "CREATE OR REPLACE FUNCTION public.orchestrator_watchdog_recover",
    );

    expect(latest.file).toBe("20260821142000_restore_queue_aware_parked_waiting.sql");
    expect(latest.source).toContain("orchestrator_queue_name_for_workflow");
    expect(latest.source).toMatch(
      /fj\.status IN \('waiting', 'retrying'\)[\s\S]*fj\.next_action_at IS NOT NULL[\s\S]*fj\.next_action_at <= NOW\(\)/,
    );
    expect(latest.source).not.toMatch(
      /fj\.status IN \('queued', 'waiting', 'retrying'\)[\s\S]*fj\.next_action_at IS NULL OR fj\.next_action_at <= NOW\(\)/,
    );
  });
});
