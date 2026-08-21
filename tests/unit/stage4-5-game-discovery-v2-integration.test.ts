import { describe, expect, it, vi } from "vitest";
import type { WorkflowTickContext } from "../../worker/workflows/types";
import { gameDiscoveryBatchV2 } from "../../worker/workflows/game-discovery-batch-v2";
import {
  buildGameDiscoveryV2ResearchPlan,
  resolveResearchPolicyV1,
} from "../../lib/research-intelligence/game-discovery-v2";

const objective = {
  schema: "discovery_objective" as const,
  version: 1 as const,
  objectiveId: "objective-v2-1",
  title: "Find a readable physics co-op core",
  searchIntent:
    "Find an unusual 2–4 player PC/Steam co-op game where the dependency is understandable in three seconds and feasible for a small prototype.",
  playerCount: { min: 2 as const, max: 4 as const },
  platform: "pc_steam" as const,
  desiredNovelty: "explore" as const,
  conceptCount: 6,
  maxConceptsToPrototype: 2,
  constraints: {},
};

function context(overrides: Partial<WorkflowTickContext> = {}): WorkflowTickContext {
  return {
    jobId: "job-v2-1",
    workflowKind: "game_discovery_batch",
    workflowVersion: 2,
    currentStage: "research_planning",
    state: {
      creative_run_id: "root-v2-1",
      discovery_objective: objective,
      research_policy: {
        mode: "required",
        freshness: "mixed",
        maxQueries: 20,
        maxSources: 30,
        maxImageCandidates: 24,
        allowExternalImageReferences: true,
        allowGameplayLibraryPromotion: false,
      },
    },
    retryCount: 0,
    signal: new AbortController().signal,
    services: {} as NonNullable<WorkflowTickContext["services"]>,
    ...overrides,
  };
}

describe("Stage 4.5 PR7 Game Discovery v2 integration", () => {
  it("builds one bounded plan with exactly the five canonical independent Scout roles", () => {
    const policy = resolveResearchPolicyV1(null);
    const plan = buildGameDiscoveryV2ResearchPlan({
      researchRunId: "research-run-1",
      objective,
      policy,
    });

    expect(plan.scoutAssignments.map((item) => item.role)).toEqual([
      "market_competitor",
      "mechanics",
      "player_voice",
      "gameplay_visual",
      "white_space_contrarian",
    ]);
    expect(plan.scoutAssignments).toHaveLength(5);
    expect(plan.scoutAssignments.every((item) => item.budget.maxModelCalls === 1)).toBe(true);
    expect(plan.scoutAssignments.reduce((sum, item) => sum + item.budget.maxSearchQueries, 0)).toBeLessThanOrEqual(20);
    expect(plan.scoutAssignments.reduce((sum, item) => sum + item.budget.maxFetchedSources, 0)).toBeLessThanOrEqual(30);
    expect(plan.scoutAssignments.reduce((sum, item) => sum + item.budget.maxImageCandidates, 0)).toBeLessThanOrEqual(24);
    expect(plan.budget.maxResearchModelCalls).toBe(6);
    expect(plan.scoutAssignments.find((item) => item.role === "gameplay_visual")?.imageSearchRequired).toBe(true);
  });

  it("keeps disabled research on the existing Stage 4 baseline path instead of failing", async () => {
    const result = await gameDiscoveryBatchV2(
      context({
        state: {
          creative_run_id: "root-v2-1",
          discovery_objective: objective,
          research_policy: {
            mode: "disabled",
            freshness: "mixed",
            allowExternalImageReferences: false,
            allowGameplayLibraryPromotion: false,
          },
        },
      }),
    );

    expect(result.status).toBe("queued");
    expect(result.currentStage).toBe("concept_generation_pending");
    expect(result.state?.research_fallback).toBe(true);
    expect(result.state?.research_coverage).toBe("disabled");
    expect(result.enqueueReason).toBe("stage4_baseline_fallback");
  });

  it("creates the ResearchRun/plan before any concept generation", async () => {
    const beginResearch = vi.fn(async () => ({
      researchRunId: "research-run-1",
      duplicate: false,
      status: "planned",
    }));
    const result = await gameDiscoveryBatchV2(
      context({
        services: {
          gameDiscoveryV2: { beginResearch },
        } as unknown as NonNullable<WorkflowTickContext["services"]>,
      }),
    );

    expect(beginResearch).toHaveBeenCalledOnce();
    expect(result.status).toBe("queued");
    expect(result.currentStage).toBe("research_fanout");
    expect(result.state?.research_run_id).toBe("research-run-1");
    expect(result.state?.research_plan).toMatchObject({
      schema: "research_plan",
      version: 1,
      researchRunId: "research-run-1",
      objectiveId: objective.objectiveId,
    });
  });

  it("stops required research before concepts when two Scouts fail", async () => {
    const markResearchFailure = vi.fn(async () => undefined);
    const result = await gameDiscoveryBatchV2(
      context({
        currentStage: "waiting_research_scouts",
        state: {
          ...context().state,
          research_run_id: "research-run-1",
        },
        services: {
          researchScouts: {
            getFanoutStatus: async () => ({
              researchRunId: "research-run-1",
              scoutCount: 5,
              terminalCount: 5,
              completedCount: 3,
              failedCount: 2,
              cancelledCount: 0,
              allTerminal: true,
              items: [],
            }),
          },
          gameDiscoveryV2: { markResearchFailure },
        } as unknown as NonNullable<WorkflowTickContext["services"]>,
      }),
    );

    expect(markResearchFailure).toHaveBeenCalledOnce();
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "RESEARCH_SCOUT_COVERAGE_FAILED", retryable: false });
  });

  it("persists research failure and returns a bounded safe error when synthesis throws", async () => {
    const markResearchFailure = vi.fn(async () => undefined);
    const technicalDump = JSON.stringify({
      issues: Array.from({ length: 30 }, (_, index) => ({
        path: ["mechanicLandscape", index, "claim"],
        code: "too_big",
        message: "Too big: expected string to have <=2000 characters",
      })),
    });
    const loadSynthesisInput = vi.fn(async () => {
      throw new Error(technicalDump);
    });

    const result = await gameDiscoveryBatchV2(
      context({
        currentStage: "research_synthesis",
        state: {
          ...context().state,
          research_run_id: "research-run-1",
          research_scout_completed_count: 5,
        },
        services: {
          researchIntelligence: { loadSynthesisInput },
          researchSynthesizerExecutor: { synthesize: vi.fn() },
          gameDiscoveryV2: { markResearchFailure },
        } as unknown as NonNullable<WorkflowTickContext["services"]>,
      }),
    );

    expect(markResearchFailure).toHaveBeenCalledOnce();
    expect(markResearchFailure).toHaveBeenCalledWith(expect.objectContaining({
      researchRunId: "research-run-1",
      code: "RESEARCH_SYNTHESIS_FAILED",
      bestEffortFallback: false,
      coverage: expect.objectContaining({
        phase: "research_synthesis",
        technical_error_name: "Error",
        technical_error_truncated: true,
      }),
    }));
    const persisted = markResearchFailure.mock.calls[0]![0];
    expect(String(persisted.coverage.technical_error_message).length).toBeLessThanOrEqual(600);
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({
      code: "RESEARCH_SYNTHESIS_FAILED",
      message: "Required research could not produce a valid Evidence Pack",
      retryable: false,
    });
    expect(String(result.error?.message)).not.toContain("mechanicLandscape");
  });

  it("falls back to Stage 4 baseline on the same Scout failure in best_effort mode", async () => {
    const markResearchFailure = vi.fn(async () => undefined);
    const result = await gameDiscoveryBatchV2(
      context({
        currentStage: "waiting_research_scouts",
        state: {
          creative_run_id: "root-v2-1",
          discovery_objective: objective,
          research_run_id: "research-run-1",
          research_policy: {
            mode: "best_effort",
            freshness: "mixed",
            allowExternalImageReferences: true,
            allowGameplayLibraryPromotion: false,
          },
        },
        services: {
          researchScouts: {
            getFanoutStatus: async () => ({
              researchRunId: "research-run-1",
              scoutCount: 5,
              terminalCount: 5,
              completedCount: 3,
              failedCount: 2,
              cancelledCount: 0,
              allTerminal: true,
              items: [],
            }),
          },
          gameDiscoveryV2: { markResearchFailure },
        } as unknown as NonNullable<WorkflowTickContext["services"]>,
      }),
    );

    expect(result.status).toBe("queued");
    expect(result.currentStage).toBe("concept_generation_pending");
    expect(result.state?.research_coverage).toBe("low");
    expect(result.state?.research_fallback_reason).toBe("scout_failure");
  });
});
