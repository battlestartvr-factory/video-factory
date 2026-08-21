import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EARLY_FINALIZE_MIN_COMPLETED_SCOUTS,
  EARLY_FINALIZE_MIN_EVIDENCE,
  evaluateResearchEarlyFinalizeEligibility,
} from "../../lib/research-intelligence/early-finalize";
import { evidencePackSpecV1Schema, type ResearchScoutRoleV1 } from "../../lib/research-intelligence/schemas";
import type {
  ResearchScoutFanoutItem,
  ResearchScoutFanoutStatus,
} from "../../lib/research-intelligence/scout-runtime";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260821100000_research_early_finalize.sql"),
  "utf8",
);
const workflow = readFileSync(
  join(process.cwd(), "worker/workflows/game-discovery-batch-v2.ts"),
  "utf8",
);
const taskCard = readFileSync(
  join(process.cwd(), "components/chat/discovery-v2-task-card.tsx"),
  "utf8",
);
const route = readFileSync(
  join(process.cwd(), "app/api/discovery/batches/[runId]/early-finalize/route.ts"),
  "utf8",
);

const roles: ResearchScoutRoleV1[] = [
  "market_competitor",
  "mechanics",
  "player_voice",
  "gameplay_visual",
  "white_space_contrarian",
];

function item(input: {
  role: ResearchScoutRoleV1;
  status: string;
  evidenceCount?: number;
}): ResearchScoutFanoutItem {
  const evidenceCount = input.evidenceCount ?? 2;
  return {
    scoutRole: input.role,
    factoryJobId: `job-${input.role}`,
    creativeRunId: `run-${input.role}`,
    jobStatus: input.status,
    retryCount: 0,
    error: null,
    report: input.status === "completed"
      ? {
          schema: "research_scout_report",
          version: 1,
          researchRunId: "research-run-early-finalize",
          scoutRole: input.role,
          summary: `Completed ${input.role}`,
          sourceIds: Array.from({ length: evidenceCount }, (_, index) => `source-${input.role}-${index}`),
          evidenceIds: Array.from({ length: evidenceCount }, (_, index) => `evidence-${input.role}-${index}`),
          imageCandidateIds: [],
          queriesExecuted: 1,
          coverageNotes: [],
          warnings: [],
          generatedAt: "2026-08-21T06:00:00.000Z",
        }
      : null,
  };
}

function status(items: ResearchScoutFanoutItem[]): ResearchScoutFanoutStatus {
  const terminal = items.filter((entry) => ["completed", "failed", "cancelled"].includes(entry.jobStatus));
  return {
    researchRunId: "research-run-early-finalize",
    scoutCount: items.length,
    terminalCount: terminal.length,
    completedCount: items.filter((entry) => entry.jobStatus === "completed").length,
    failedCount: items.filter((entry) => entry.jobStatus === "failed").length,
    cancelledCount: items.filter((entry) => entry.jobStatus === "cancelled").length,
    allTerminal: terminal.length === items.length,
    items,
  };
}

describe("PR4 Research early-finalize eligibility", () => {
  it("becomes eligible only after four independent completed Scouts cover critical roles with enough evidence", () => {
    const result = evaluateResearchEarlyFinalizeEligibility(status([
      item({ role: "market_competitor", status: "completed" }),
      item({ role: "mechanics", status: "completed" }),
      item({ role: "player_voice", status: "completed" }),
      item({ role: "white_space_contrarian", status: "completed" }),
      item({ role: "gameplay_visual", status: "running" }),
    ]));

    expect(EARLY_FINALIZE_MIN_COMPLETED_SCOUTS).toBe(4);
    expect(EARLY_FINALIZE_MIN_EVIDENCE).toBe(8);
    expect(result).toMatchObject({
      eligible: true,
      completedScouts: 4,
      pendingScouts: 1,
      evidenceCount: 8,
      missingCriticalRoles: [],
    });
  });

  it("stays ineligible for thin coverage, missing critical roles, or a pre-existing failure", () => {
    const onlyThree = evaluateResearchEarlyFinalizeEligibility(status([
      item({ role: "mechanics", status: "completed", evidenceCount: 3 }),
      item({ role: "player_voice", status: "completed", evidenceCount: 3 }),
      item({ role: "white_space_contrarian", status: "completed", evidenceCount: 3 }),
      item({ role: "market_competitor", status: "running" }),
      item({ role: "gameplay_visual", status: "running" }),
    ]));
    expect(onlyThree.eligible).toBe(false);

    const missingWhiteSpace = evaluateResearchEarlyFinalizeEligibility(status([
      item({ role: "market_competitor", status: "completed" }),
      item({ role: "mechanics", status: "completed" }),
      item({ role: "player_voice", status: "completed" }),
      item({ role: "gameplay_visual", status: "completed" }),
      item({ role: "white_space_contrarian", status: "running" }),
    ]));
    expect(missingWhiteSpace.eligible).toBe(false);
    expect(missingWhiteSpace.missingCriticalRoles).toContain("white_space_contrarian");

    const withFailure = evaluateResearchEarlyFinalizeEligibility(status([
      item({ role: "market_competitor", status: "completed" }),
      item({ role: "mechanics", status: "completed" }),
      item({ role: "player_voice", status: "completed" }),
      item({ role: "white_space_contrarian", status: "completed" }),
      item({ role: "gameplay_visual", status: "failed" }),
    ]));
    expect(withFailure.eligible).toBe(false);
  });

  it("supports an explicit early_finalized Evidence Pack marker without breaking old full packs", () => {
    const base = {
      schema: "evidence_pack" as const,
      version: 1 as const,
      packId: "pack-1",
      researchRunId: "research-1",
      objectiveId: "objective-1",
      marketLandscape: [],
      mechanicLandscape: [],
      playerPositiveSignals: [],
      playerPainSignals: [],
      saturatedPatterns: [],
      whiteSpaces: [],
      counterexamples: [],
      gameplayReferencePatterns: [],
      visualReferencePatterns: [],
      contradictions: [],
      selectedSourceIds: [],
      selectedImageReferenceIds: [],
      coverage: {},
      generatedAt: "2026-08-21T06:00:00.000Z",
    };

    expect(evidencePackSpecV1Schema.parse(base).finalization).toBeUndefined();
    expect(evidencePackSpecV1Schema.parse({ ...base, finalization: "early_finalized" }).finalization)
      .toBe("early_finalized");
  });
});

describe("PR4 durable Answer now contract", () => {
  it("cancels only unfinished Scout jobs and keeps the root alive for immediate synthesis", () => {
    expect(migration).toContain("orchestrator_request_research_early_finalize");
    expect(migration).toContain("v_root.current_stage <> 'waiting_research_scouts'");
    expect(migration).toContain("(v_early->>'eligible')::BOOLEAN");
    expect(migration).toContain("public.research_scout_assignments AS rsa");
    expect(migration).toContain("cancel_reason = COALESCE(fj.cancel_reason, 'research_early_finalize')");
    expect(migration).toContain("state = jsonb_set(v_state, '{research_early_finalize}', v_early, true)");
    expect(migration).toContain("next_action_at = NOW()");
    expect(migration).toContain("'research.early_finalize_requested'");
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.orchestrator_request_research_early_finalize[\s\S]*TO service_role/);
  });

  it("propagates eligibility into durable workflow state and marks synthesis output", () => {
    expect(workflow).toContain("evaluateResearchEarlyFinalizeEligibility(status)");
    expect(workflow).toContain("research_early_finalize: earlyFinalize");
    expect(workflow).toContain('finalization: earlyFinalizeRequested ? "early_finalized" : "full"');
    expect(workflow).toContain("finalization,");
    expect(workflow).toContain("research_finalization: result.pack.finalization ?? finalization");
  });

  it("shows Ответить сейчас only from durable eligibility and calls the authenticated endpoint", () => {
    expect(route).toContain("getSessionUser");
    expect(route).toContain("earlyFinalizeGameDiscoveryResearch");
    expect(taskCard).toContain('currentStage === "waiting_research_scouts"');
    expect(taskCard).toContain("earlyFinalize.eligible === true");
    expect(taskCard).toContain('"Ответить сейчас"');
    expect(taskCard).toContain("/early-finalize");
    expect(taskCard).toContain('researchFinalization === "early_finalized"');
  });
});
