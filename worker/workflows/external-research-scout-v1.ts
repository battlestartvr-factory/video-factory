import { DurableWorkflowError } from "../../lib/orchestrator/retry";
import { researchScoutEvidenceBundleV1Schema } from "../../lib/research-intelligence/evidence-bundle";
import { createKieGroundedResearchScoutExecutor } from "../../lib/research-intelligence/kie-research-scout";
import type { ResearchScoutExecutor } from "../../lib/research-intelligence/scout-runtime";
import { researchScoutReportSpecV1Schema } from "../../lib/research-intelligence/schemas";
import type { WorkflowTickHandler } from "./types";

let productionKieExecutor: ResearchScoutExecutor | null = null;

function resolveProductionKieExecutor(): ResearchScoutExecutor | null {
  if ((process.env.WEB_SEARCH_PROVIDER ?? "").trim().toLowerCase() !== "kie") return null;
  if (!(process.env.KIE_API_KEY ?? process.env.AGENT_LLM_API_KEY ?? "").trim()) return null;
  productionKieExecutor ??= createKieGroundedResearchScoutExecutor();
  return productionKieExecutor;
}

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

  const executor = context.services?.researchScoutExecutor ?? resolveProductionKieExecutor();
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
  let report = researchScoutReportSpecV1Schema.parse(execution.report);

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

  let evidencePersistDuplicate = false;
  if (execution.evidenceBundle) {
    const research = context.services?.researchIntelligence;
    if (!research) {
      throw new DurableWorkflowError({
        code: "RESEARCH_EVIDENCE_REPOSITORY_NOT_CONFIGURED",
        message: "Scout returned source-backed evidence but Research Intelligence repository is missing",
        retryable: false,
      });
    }
    const bundle = researchScoutEvidenceBundleV1Schema.parse(execution.evidenceBundle);
    if (bundle.researchRunId !== scout.researchRunId || bundle.scoutRole !== scout.scoutRole) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SCOUT_EVIDENCE_LINEAGE_MISMATCH",
        message: "Scout evidence bundle belongs to another durable assignment",
        retryable: false,
      });
    }
    if (
      bundle.sources.length > scout.assignment.budget.maxFetchedSources ||
      bundle.evidence.length > scout.assignment.budget.maxEvidenceItems
    ) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SCOUT_EVIDENCE_BUDGET_EXCEEDED",
        message: "Scout evidence bundle exceeds its durable source/evidence budget",
        retryable: false,
        details: {
          source_count: bundle.sources.length,
          max_sources: scout.assignment.budget.maxFetchedSources,
          evidence_count: bundle.evidence.length,
          max_evidence: scout.assignment.budget.maxEvidenceItems,
        },
      });
    }

    const persistedEvidence = await research.persistScoutEvidenceBundle({
      jobId: context.jobId,
      bundle,
    });
    evidencePersistDuplicate = persistedEvidence.duplicate;

    const sourceIds = report.sourceIds.map((ref) => persistedEvidence.sourceIdsByRef[ref]);
    const evidenceIds = report.evidenceIds.map((ref) => persistedEvidence.evidenceIdsByRef[ref]);
    if (sourceIds.some((id) => !id) || evidenceIds.some((id) => !id)) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SCOUT_REPORT_EVIDENCE_REF_INVALID",
        message: "Scout report source/evidence refs do not match its atomic evidence bundle",
        retryable: false,
      });
    }
    report = researchScoutReportSpecV1Schema.parse({
      ...report,
      sourceIds,
      evidenceIds,
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
      evidence_persist_duplicate: evidencePersistDuplicate,
      report_persist_duplicate: persisted.duplicate,
    },
    result: { scout_report: persisted.report },
    stateReason: "research_scout_completed",
    eventType: "research.scout.completed",
    eventPayload: {
      research_run_id: scout.researchRunId,
      scout_role: scout.scoutRole,
      evidence_persist_duplicate: evidencePersistDuplicate,
      report_persist_duplicate: persisted.duplicate,
    },
    creativeRunId: scout.creativeRunId,
  };
};
