import { describe, expect, it } from "vitest";
import {
  EARLY_FINALIZE_MIN_COMPLETED_SCOUTS,
  EARLY_FINALIZE_MIN_EVIDENCE,
  evaluateResearchEarlyFinalizeEligibility,
} from "./early-finalize";
import type {
  ResearchScoutFanoutItem,
  ResearchScoutFanoutStatus,
} from "./scout-runtime";
import type { ResearchScoutRoleV1 } from "./schemas";

const roles: ResearchScoutRoleV1[] = [
  "market_competitor",
  "mechanics",
  "player_voice",
  "gameplay_visual",
  "white_space_contrarian",
];

function item(
  scoutRole: ResearchScoutRoleV1,
  jobStatus: string,
  evidenceCount: number,
): ResearchScoutFanoutItem {
  const report = jobStatus === "completed"
    ? ({
        evidenceIds: Array.from({ length: evidenceCount }, (_, index) => `${scoutRole}-${index}`),
      } as unknown as NonNullable<ResearchScoutFanoutItem["report"]>)
    : null;
  return {
    scoutRole,
    factoryJobId: `job-${scoutRole}`,
    creativeRunId: `run-${scoutRole}`,
    jobStatus,
    retryCount: 0,
    error: null,
    report,
  };
}

function status(items: ResearchScoutFanoutItem[]): ResearchScoutFanoutStatus {
  const terminal = items.filter((entry) => ["completed", "failed", "cancelled"].includes(entry.jobStatus));
  return {
    researchRunId: "research-run",
    scoutCount: items.length,
    terminalCount: terminal.length,
    completedCount: items.filter((entry) => entry.jobStatus === "completed").length,
    failedCount: items.filter((entry) => entry.jobStatus === "failed").length,
    cancelledCount: items.filter((entry) => entry.jobStatus === "cancelled").length,
    allTerminal: items.length === 5 && terminal.length === 5,
    earlyFinalized: false,
    items,
  };
}

describe("evaluateResearchEarlyFinalizeEligibility", () => {
  it("allows one pending Scout after conservative evidence and critical-role coverage", () => {
    const result = evaluateResearchEarlyFinalizeEligibility(status([
      item("market_competitor", "completed", 2),
      item("mechanics", "completed", 2),
      item("player_voice", "completed", 2),
      item("white_space_contrarian", "completed", 2),
      item("gameplay_visual", "running", 0),
    ]));

    expect(result.eligible).toBe(true);
    expect(result.completedScouts).toBe(EARLY_FINALIZE_MIN_COMPLETED_SCOUTS);
    expect(result.evidenceCount).toBe(EARLY_FINALIZE_MIN_EVIDENCE);
    expect(result.pendingScouts).toBe(1);
    expect(result.missingCriticalRoles).toEqual([]);
  });

  it("does not finalize when a critical role is still pending", () => {
    const result = evaluateResearchEarlyFinalizeEligibility(status([
      item("market_competitor", "completed", 2),
      item("mechanics", "completed", 2),
      item("player_voice", "completed", 2),
      item("gameplay_visual", "completed", 2),
      item("white_space_contrarian", "running", 0),
    ]));

    expect(result.eligible).toBe(false);
    expect(result.missingCriticalRoles).toEqual(["white_space_contrarian"]);
  });

  it("does not reinterpret a failed Scout as an early-finalize opportunity", () => {
    const result = evaluateResearchEarlyFinalizeEligibility(status([
      item("market_competitor", "completed", 2),
      item("mechanics", "completed", 2),
      item("player_voice", "completed", 2),
      item("white_space_contrarian", "completed", 2),
      item("gameplay_visual", "failed", 0),
    ]));

    expect(result.eligible).toBe(false);
  });

  it("does not run after the normal five-Scout fan-in is already terminal", () => {
    const result = evaluateResearchEarlyFinalizeEligibility(status(
      roles.map((role) => item(role, "completed", 2)),
    ));

    expect(result.eligible).toBe(false);
    expect(result.pendingScouts).toBe(0);
  });
});
