import type { ResearchScoutExecutionResult, ResearchScoutExecutor } from "./scout-runtime";

/**
 * Deterministic no-provider executor used only by MOCK_WORKFLOWS / tests.
 * Real Stage 4.5 research execution will use the PR2 ResearchToolbox under the same
 * executor contract; this mock proves durable fan-out/fan-in without paid calls.
 */
export class MockResearchScoutExecutor implements ResearchScoutExecutor {
  async execute(input: Parameters<ResearchScoutExecutor["execute"]>[0]): Promise<ResearchScoutExecutionResult> {
    const { context } = input;
    const queryCount = Math.min(
      context.assignment.queryAngles.length,
      context.assignment.budget.maxSearchQueries,
    );
    return {
      report: {
        schema: "research_scout_report",
        version: 1,
        researchRunId: context.researchRunId,
        scoutRole: context.scoutRole,
        summary: `Mock Scout completed the ${context.scoutRole} mandate for objective ${context.objectiveId}.`,
        sourceIds: [],
        evidenceIds: [],
        imageCandidateIds: [],
        queriesExecuted: queryCount,
        coverageNotes: ["mock_acceptance_no_provider_calls"],
        warnings: [],
        generatedAt: new Date().toISOString(),
      },
      usage: { modelCalls: 0, mock: true },
      model: "mock-research-scout",
      provider: "mock",
    };
  }
}
