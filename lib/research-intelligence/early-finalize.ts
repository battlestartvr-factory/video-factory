import type { ResearchScoutFanoutStatus } from "./scout-runtime";
import type { ResearchScoutRoleV1 } from "./schemas";

export const EARLY_FINALIZE_MIN_COMPLETED_SCOUTS = 4;
export const EARLY_FINALIZE_MIN_EVIDENCE = 8;
export const EARLY_FINALIZE_MIN_COVERED_ROLES = 4;
export const EARLY_FINALIZE_CRITICAL_ROLES = [
  "mechanics",
  "player_voice",
  "white_space_contrarian",
] as const satisfies readonly ResearchScoutRoleV1[];

export interface ResearchEarlyFinalizeEligibilityV1 {
  eligible: boolean;
  completedScouts: number;
  pendingScouts: number;
  evidenceCount: number;
  coveredRoles: ResearchScoutRoleV1[];
  missingCriticalRoles: ResearchScoutRoleV1[];
}

export function evaluateResearchEarlyFinalizeEligibility(
  status: ResearchScoutFanoutStatus,
): ResearchEarlyFinalizeEligibilityV1 {
  const completed = status.items.filter(
    (item) => item.jobStatus === "completed" && item.report !== null,
  );
  const coveredRoles = completed
    .filter((item) => (item.report?.evidenceIds.length ?? 0) > 0)
    .map((item) => item.scoutRole);
  const coveredRoleSet = new Set<ResearchScoutRoleV1>(coveredRoles);
  const evidenceCount = completed.reduce(
    (total, item) => total + (item.report?.evidenceIds.length ?? 0),
    0,
  );
  const pendingScouts = Math.max(0, status.scoutCount - status.terminalCount);
  const missingCriticalRoles = EARLY_FINALIZE_CRITICAL_ROLES.filter(
    (role) => !coveredRoleSet.has(role),
  );

  const eligible =
    !status.allTerminal &&
    status.failedCount === 0 &&
    status.cancelledCount === 0 &&
    completed.length >= EARLY_FINALIZE_MIN_COMPLETED_SCOUTS &&
    pendingScouts >= 1 &&
    evidenceCount >= EARLY_FINALIZE_MIN_EVIDENCE &&
    coveredRoleSet.size >= EARLY_FINALIZE_MIN_COVERED_ROLES &&
    missingCriticalRoles.length === 0;

  return {
    eligible,
    completedScouts: completed.length,
    pendingScouts,
    evidenceCount,
    coveredRoles: [...coveredRoleSet],
    missingCriticalRoles,
  };
}
