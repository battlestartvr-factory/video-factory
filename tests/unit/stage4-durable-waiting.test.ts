import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { enforceStage4DurableWakeup } from "../../worker/workflows/game-discovery-batch-stage4-durable-v1";

const finishTickMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260818180314_stage4_parked_waiting_contract.sql"),
  "utf-8",
);
const watchdogMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260818180843_stage4_parked_waiting_watchdog.sql"),
  "utf-8",
);

describe("Stage 4 durable waiting contract", () => {
  it("immediately wakes the persisted gameplay-moment handoff to shot planning", () => {
    const outcome = enforceStage4DurableWakeup({
      status: "waiting",
      currentStage: "shot_planning_pending",
      progress: 65,
      nextActionAt: null,
      stateReason: "s4_004_gameplay_moments_ready",
    });

    expect(outcome.currentStage).toBe("shot_planning_pending");
    expect(outcome.nextActionAt).toEqual(expect.any(String));
    expect(outcome.enqueueReason).toBe("shot_planning");
  });

  it("preserves a human approval wait as an intentionally parked job", () => {
    const outcome = enforceStage4DurableWakeup({
      status: "waiting",
      currentStage: "human_reference_approval_pending",
      progress: 85,
      nextActionAt: null,
      stateReason: "s4_005_waiting_for_human_reference_review",
    });

    expect(outcome.nextActionAt).toBeNull();
    expect(outcome.enqueueReason).toBeUndefined();
  });

  it("does not leave the approval gate after only one of several reference decisions", () => {
    const outcome = enforceStage4DurableWakeup({
      status: "waiting",
      currentStage: "reference_revision_pending",
      progress: 86,
      nextActionAt: new Date().toISOString(),
      enqueueReason: "reference_revision",
      state: {
        revision_shot_ids: ["shot-a"],
        reference_approvals: [
          { shotId: "shot-a", decision: "revise" },
          { shotId: "shot-b", decision: null },
        ],
      },
    });

    expect(outcome.currentStage).toBe("human_reference_approval_pending");
    expect(outcome.progress).toBe(85);
    expect(outcome.nextActionAt).toBeNull();
    expect(outcome.enqueueReason).toBeNull();
    expect(outcome.state).not.toHaveProperty("revision_shot_ids");
  });

  it("allows revision once every current reference has a decision", () => {
    const now = new Date().toISOString();
    const outcome = enforceStage4DurableWakeup({
      status: "waiting",
      currentStage: "reference_revision_pending",
      progress: 86,
      nextActionAt: now,
      enqueueReason: "reference_revision",
      state: {
        revision_shot_ids: ["shot-a"],
        reference_approvals: [
          { shotId: "shot-a", decision: "revise" },
          { shotId: "shot-b", decision: "reject" },
        ],
      },
    });

    expect(outcome.currentStage).toBe("reference_revision_pending");
    expect(outcome.nextActionAt).toBe(now);
    expect(outcome.enqueueReason).toBe("reference_revision");
  });

  it("allows timerless waiting but still requires a retry timer", () => {
    expect(finishTickMigration).toMatch(/p_new_status='retrying' AND p_next_action_at IS NULL/);
    expect(finishTickMigration).not.toMatch(/p_new_status IN \('waiting','retrying'\) AND p_next_action_at IS NULL/);
    expect(finishTickMigration).toMatch(
      /p_new_status='queued' OR \(p_new_status IN \('waiting','retrying'\) AND v_effective_next_action IS NOT NULL\)/,
    );
  });

  it("does not watchdog-enqueue parked waiting jobs", () => {
    expect(watchdogMigration).toMatch(
      /fj\.status IN \('waiting','retrying'\) AND fj\.next_action_at IS NOT NULL AND fj\.next_action_at<=NOW\(\)/,
    );
  });
});
