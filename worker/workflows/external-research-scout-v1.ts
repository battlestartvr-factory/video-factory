import { DurableWorkflowError } from "../../lib/orchestrator/retry";
import { researchScoutReportSpecV1Schema } from "../../lib/research-intelligence/schemas";
import type { WorkflowTickHandler } from "./types";

export const externalResearchScoutV1: WorkflowTickHandler = async (context) => {
  const repository = context.services?.researchScouts;
  if (!repository) {
    throw new DurableWorkflowError({
      code: "RESEARCH_SCOUT_REPOSITORY_NOT_CONFIGURED",
      message: "Research Scout durable repository is not configured",
      retryable: false,
    });
  }

  const scout = await repository.beginScoutJob(context.jobId);

  // Critical restart boundary: if the paid/tool execution already persisted its typed
  // report but the worker died before factory_jobs finish, complete from durable data.
  if (scout.existingReport) {
    return {
      status: "completed",
      currentStage: "research_scout_completed",
      progress: 100,
      state: {
        ...context.state,
        research_run_id: scout.researchRunId,
        scout_role: scout.scoutRole,
        phase: "completed",
        recovered_from_persisted_report: true,
      },
      result: { scout_report: scout.existingReport },
      stateReason: "scout_report_already_persisted",
      eventType: "research.scout.completed",
      eventPayload: {
        research_run_id: scout.researchRunId,
        scout_role: scout.scoutRole,
        recovered_from_persisted_report: true,
      },
      creativeRunId: scout.creativeRunId,
    };
  }

  const executor = context.services?.researchScoutExecutor;
  if (!executor) {
    throw new DurableWorkflowError({
      code: "RESEARCH_SCOUT_EXECUTOR_NOT_CONFIGURED",
      message: "Research Scout executor is not configured for this worker",
      retryable: false,
      details: {
        research_run_id: scout.researchRunId,
        scout_role: scout.scoutRole,
      },
    });
  }

  const execution = await executor.execute({
    jobId: context.jobId,
    context: scout,
    signal: context.signal,
  });
  const report = researchScoutReportSpecV1Schema.parse(execution.report);

  if (report.researchRunId !== scout.researchRunId || report.scoutRole !== scout.scoutRole) {
    throw new DurableWorkflowError({
      code: "RESEARCH_SCOUT_REPORT_LINEAGE_MISMATCH",
      message: "Research Scout executor returned a report for another durable assignment",
      retryable: false,
    });
  }
  if (report.queriesExecuted > scout.assignment.budget.maxSearchQueries) {
    throw new DurableWorkflowError({
      code: "RESEARCH_SCOUT_QUERY_BUDGET_EXCEEDED",
      message: "Research Scout report exceeds its durable query budget",
      retryable: false,
      details: {
        queries_executed: report.queriesExecuted,
        max_search_queries: scout.assignment.budget.maxSearchQueries,
      },
    });
  }

  const persisted = await repository.persistScoutReport({
    jobId: context.jobId,
    report,
    usage: execution.usage,
    model: execution.model,
    provider: execution.provider,
  });

  return {
    status: "completed",
    currentStage: "research_scout_completed",
    progress: 100,
    state: {
      ...context.state,
      research_run_id: scout.researchRunId,
      scout_role: scout.scoutRole,
      phase: "completed",
      report_persist_duplicate: persisted.duplicate,
    },
    result: { scout_report: persisted.report },
    stateReason: "research_scout_completed",
    eventType: "research.scout.completed",
    eventPayload: {
      research_run_id: scout.researchRunId,
      scout_role: scout.scoutRole,
      report_persist_duplicate: persisted.duplicate,
    },
    creativeRunId: scout.creativeRunId,
  };
};
