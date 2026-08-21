import { DurableWorkflowError } from "../../lib/orchestrator/retry";
import { researchScoutEvidenceBundleV1Schema } from "../../lib/research-intelligence/evidence-bundle";
import { createInternalKieResearchScoutExecutor } from "../../lib/research-intelligence/kie-research-scout-client";
import type { ResearchScoutExecutor } from "../../lib/research-intelligence/scout-runtime";
import { researchScoutReportSpecV1Schema } from "../../lib/research-intelligence/schemas";
import type { WorkflowTickHandler } from "./types";

let productionKieExecutor: ResearchScoutExecutor | null = null;
let productionKieExecutorResolved = false;

function resolveProductionKieExecutor(): ResearchScoutExecutor | null {
  if (!productionKieExecutorResolved) {
    productionKieExecutor = createInternalKieResearchScoutExecutor();
    productionKieExecutorResolved = true;
  }
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

  const research = context.services?.researchIntelligence;
  let evidencePersistDuplicate = false;
  if (execution.evidenceBundle) {
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

    // Trace persistence must never turn a successfully paid Scout execution into a retry.
    // If this best-effort write fails, the durable evidence tables remain the recovery truth.
    try {
      await research.recordProgressEvent({
        rootFactoryJobId: scout.rootFactoryJobId,
        jobId: context.jobId,
        researchRunId: scout.researchRunId,
        scoutRole: scout.scoutRole,
        eventType: "research.evidence.persisted",
        dedupeKey: `research:evidence:persisted:${context.jobId}:${persistedEvidence.bundleHash}`,
        payload: {
          source_count: Object.keys(persistedEvidence.sourceIdsByRef).length,
          evidence_count: persistedEvidence.evidence.length,
          duplicate: persistedEvidence.duplicate,
          items: persistedEvidence.evidence.slice(0, 12).map((item) => ({
            id: item.evidenceId,
            evidence_type: item.evidenceType,
            subject: item.subject.slice(0, 300),
            claim: item.claim.slice(0, 1_000),
            confidence: item.confidence,
          })),
        },
      });
    } catch {
      // Observability is recoverable from Research Memory; do not repeat a paid call.
    }

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

  if (research) {
    try {
      await research.recordProgressEvent({
        rootFactoryJobId: scout.rootFactoryJobId,
        jobId: context.jobId,
        researchRunId: scout.researchRunId,
        scoutRole: scout.scoutRole,
        eventType: "research.scout.persisted",
        dedupeKey: `research:scout:persisted:${context.jobId}`,
        payload: {
          duplicate: persisted.duplicate,
          source_count: persisted.report.sourceIds.length,
          evidence_count: persisted.report.evidenceIds.length,
        },
      });
    } catch {
      // The persisted Scout report is the restart boundary; never retry only for trace IO.
    }
  }

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
