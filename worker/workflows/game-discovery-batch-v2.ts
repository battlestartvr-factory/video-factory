import { DurableWorkflowError } from "../../lib/orchestrator/retry";
import { ConceptCouncilCuratorService } from "../../lib/research-intelligence/concept-curator";
import { evaluateResearchEarlyFinalizeEligibility } from "../../lib/research-intelligence/early-finalize";
import { ResearchDirector } from "../../lib/research-intelligence/scout-runtime";
import { ResearchSynthesisService } from "../../lib/research-intelligence/synthesis";
import {
  buildGameDiscoveryV2ResearchPlan,
  researchCoverageSummary,
  resolveResearchPolicyV1,
} from "../../lib/research-intelligence/game-discovery-v2";
import { evidencePackSpecV1Schema } from "../../lib/research-intelligence/schemas";
import { gameDiscoveryBatchStage4InspectedV1 } from "./game-discovery-batch-stage4-inspected-v1";
import type { WorkflowTickContext, WorkflowTickHandler, WorkflowTickOutcome } from "./types";

const FAN_IN_POLL_MS = 5_000;

type ResearchSynthesisRunResult = Awaited<ReturnType<ResearchSynthesisService["run"]>>;

function nextAt(delayMs = FAN_IN_POLL_MS): string {
  return new Date(Date.now() + delayMs).toISOString();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedResearchFailureDiagnostic(error: unknown): Record<string, unknown> {
  const row = record(error);
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof row.message === "string"
        ? row.message
        : typeof error === "string"
          ? error
          : "";
  const normalizedMessage = rawMessage.replace(/\s+/g, " ").trim();
  const errorName = error instanceof Error ? error.name : null;
  const errorCode = typeof row.code === "string" && row.code.trim() ? row.code.trim() : null;

  return {
    ...(errorName ? { technical_error_name: errorName.slice(0, 120) } : {}),
    ...(errorCode ? { technical_error_code: errorCode.slice(0, 160) } : {}),
    ...(normalizedMessage ? { technical_error_message: normalizedMessage.slice(0, 600) } : {}),
    technical_error_truncated: normalizedMessage.length > 600,
  };
}

function creativeRunId(context: WorkflowTickContext): string {
  const value = context.state.creative_run_id;
  if (typeof value !== "string" || !value) {
    throw new DurableWorkflowError({
      code: "GAME_DISCOVERY_V2_CREATIVE_RUN_MISSING",
      message: "game_discovery_batch@2 requires creative_run_id in durable state",
      retryable: false,
    });
  }
  return value;
}

function objective(context: WorkflowTickContext) {
  const parsed = context.state.discovery_objective;
  const services = context.services;
  if (!services) {
    throw new DurableWorkflowError({
      code: "GAME_DISCOVERY_V2_SERVICES_MISSING",
      message: "game_discovery_batch@2 requires worker services",
      retryable: false,
    });
  }
  return { parsed, services };
}

function researchRunId(context: WorkflowTickContext): string {
  const value = context.state.research_run_id;
  if (typeof value !== "string" || !value) {
    throw new DurableWorkflowError({
      code: "GAME_DISCOVERY_V2_RESEARCH_RUN_MISSING",
      message: "Game Discovery v2 durable state is missing research_run_id",
      retryable: false,
    });
  }
  return value;
}

function baselineFallback(input: {
  context: WorkflowTickContext;
  reason: "disabled" | "low" | "scout_failure" | "synthesis_failure";
  details?: Record<string, unknown>;
}): WorkflowTickOutcome {
  return {
    status: "queued",
    currentStage: "concept_generation_pending",
    progress: 5,
    state: {
      ...input.context.state,
      research_fallback: true,
      research_coverage: input.reason === "disabled" ? "disabled" : "low",
      research_fallback_reason: input.reason,
      ...(input.details ? { research_fallback_details: input.details } : {}),
    },
    stateReason: `game_discovery_v2_research_fallback:${input.reason}`,
    eventType: "research.fallback",
    eventPayload: {
      reason: input.reason,
      ...(input.details ?? {}),
    },
    enqueueReason: "stage4_baseline_fallback",
  };
}

function terminalResearchFailure(input: {
  context: WorkflowTickContext;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): WorkflowTickOutcome {
  return {
    status: "failed",
    currentStage: input.context.currentStage,
    state: input.context.state,
    error: {
      code: input.code,
      message: input.message,
      retryable: false,
      ...(input.details ? { details: input.details } : {}),
    },
    stateReason: `game_discovery_v2_failed:${input.code}`,
    eventType: "job.failed",
    eventPayload: {
      error_code: input.code,
      ...(input.details ?? {}),
    },
    creativeRunId: creativeRunId(input.context),
  };
}

async function stage4Handoff(context: WorkflowTickContext): Promise<WorkflowTickOutcome> {
  // The Stage 4 wrappers are deliberately reused instead of copied. They operate on the
  // same root creative-run/concept surfaces and preserve concept/reference/video gates.
  return gameDiscoveryBatchStage4InspectedV1(context);
}

export const gameDiscoveryBatchV2: WorkflowTickHandler = async (context) => {
  if (context.signal.aborted) throw new Error("game_discovery_batch@2 tick aborted");
  const rootCreativeRunId = creativeRunId(context);
  const { services } = objective(context);

  const policy = resolveResearchPolicyV1(
    context.state.research_policy && typeof context.state.research_policy === "object"
      ? (context.state.research_policy as never)
      : undefined,
  );

  if (context.currentStage === "research_planning") {
    if (policy.mode === "disabled") {
      return baselineFallback({ context, reason: "disabled" });
    }
    if (!services.gameDiscoveryV2) {
      throw new DurableWorkflowError({
        code: "GAME_DISCOVERY_V2_REPOSITORY_NOT_CONFIGURED",
        message: "Game Discovery v2 repository is not configured",
        retryable: false,
      });
    }

    const parsedObjective = await import("../../lib/game-discovery/schemas").then(({ discoveryObjectiveSpecV1Schema }) =>
      discoveryObjectiveSpecV1Schema.parse(context.state.discovery_objective),
    );
    const run = await services.gameDiscoveryV2.beginResearch({
      jobId: context.jobId,
      rootCreativeRunId,
      objective: parsedObjective,
      researchPolicy: policy,
    });
    const plan = buildGameDiscoveryV2ResearchPlan({
      researchRunId: run.researchRunId,
      objective: parsedObjective,
      policy,
    });

    return {
      status: "queued",
      currentStage: "research_fanout",
      progress: 4,
      state: {
        ...context.state,
        research_run_id: run.researchRunId,
        research_plan: plan,
        research_fallback: false,
      },
      stateReason: run.duplicate ? "research_plan_reconciled" : "research_plan_created",
      eventType: "research.plan_ready",
      eventPayload: {
        research_run_id: run.researchRunId,
        duplicate: run.duplicate,
        mode: policy.mode,
        max_queries: policy.maxQueries,
        max_sources: policy.maxSources,
        max_image_candidates: policy.maxImageCandidates,
      },
      enqueueReason: "research_fanout",
      creativeRunId: rootCreativeRunId,
    };
  }

  if (context.currentStage === "research_fanout") {
    if (!services.researchScouts) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SCOUT_REPOSITORY_NOT_CONFIGURED",
        message: "Research Scout repository is not configured",
        retryable: false,
      });
    }
    const plan = await import("../../lib/research-intelligence/schemas").then(({ researchPlanSpecV1Schema }) =>
      researchPlanSpecV1Schema.parse(context.state.research_plan),
    );
    const director = new ResearchDirector(services.researchScouts);
    const fanout = await director.fanOut(plan);
    return {
      status: "waiting",
      currentStage: "waiting_research_scouts",
      progress: 8,
      nextActionAt: nextAt(),
      state: {
        ...context.state,
        research_run_id: fanout.researchRunId,
        research_scout_jobs: fanout.scouts.map((item) => ({
          scout_role: item.scoutRole,
          factory_job_id: item.factoryJobId,
          creative_run_id: item.creativeRunId,
        })),
      },
      stateReason: "waiting_for_five_research_scouts",
      eventType: "research.scouts_fanned_out",
      eventPayload: { research_run_id: fanout.researchRunId, scout_count: fanout.scouts.length },
      enqueueReason: "research_fan_in_poll",
      creativeRunId: rootCreativeRunId,
    };
  }

  if (context.currentStage === "waiting_research_scouts") {
    if (!services.researchScouts || !services.gameDiscoveryV2) {
      throw new DurableWorkflowError({
        code: "GAME_DISCOVERY_V2_RESEARCH_SERVICES_NOT_CONFIGURED",
        message: "Game Discovery v2 research services are not configured",
        retryable: false,
      });
    }
    const runId = researchRunId(context);
    const status = await services.researchScouts.getFanoutStatus(runId);
    const eligibility = evaluateResearchEarlyFinalizeEligibility(status);
    const existingEarlyFinalize = record(context.state.research_early_finalize);
    const earlyFinalizeRequested = existingEarlyFinalize.requested === true;
    const earlyFinalize = {
      eligible: !earlyFinalizeRequested && eligibility.eligible,
      requested: earlyFinalizeRequested,
      requested_at:
        typeof existingEarlyFinalize.requested_at === "string"
          ? existingEarlyFinalize.requested_at
          : null,
      finalization: earlyFinalizeRequested ? "early_finalized" : "full",
      completed_scouts: eligibility.completedScouts,
      pending_scouts: eligibility.pendingScouts,
      evidence_count: eligibility.evidenceCount,
      covered_roles: eligibility.coveredRoles,
      missing_critical_roles: eligibility.missingCriticalRoles,
    };

    if (!status.allTerminal) {
      return {
        status: "waiting",
        currentStage: "waiting_research_scouts",
        progress: Math.min(28, 8 + status.terminalCount * 4),
        nextActionAt: nextAt(),
        state: {
          ...context.state,
          research_early_finalize: earlyFinalize,
        },
        stateReason: `research_scouts_terminal:${status.terminalCount}/5`,
        eventType: "research.scouts_waiting",
        eventPayload: {
          research_run_id: runId,
          terminal_count: status.terminalCount,
          completed_count: status.completedCount,
          failed_count: status.failedCount,
          cancelled_count: status.cancelledCount,
          early_finalize_eligible: earlyFinalize.eligible,
          early_finalize_evidence_count: eligibility.evidenceCount,
          early_finalize_covered_roles: eligibility.coveredRoles,
        },
        enqueueReason: "research_fan_in_poll",
        creativeRunId: rootCreativeRunId,
      };
    }

    const terminalFailures = status.failedCount + status.cancelledCount;
    if (terminalFailures >= 2) {
      const details = {
        research_run_id: runId,
        completed_count: status.completedCount,
        failed_count: status.failedCount,
        cancelled_count: status.cancelledCount,
      };
      await services.gameDiscoveryV2.markResearchFailure({
        researchRunId: runId,
        code: "RESEARCH_SCOUT_COVERAGE_FAILED",
        message: "Two or more Research Scouts failed/cancelled before synthesis",
        coverage: details,
        bestEffortFallback: policy.mode === "best_effort",
      });
      if (policy.mode === "best_effort") {
        return baselineFallback({ context, reason: "scout_failure", details });
      }
      return terminalResearchFailure({
        context,
        code: "RESEARCH_SCOUT_COVERAGE_FAILED",
        message: "Required research stopped before concepts because two or more Scouts failed",
        details,
      });
    }

    return {
      status: "queued",
      currentStage: "research_synthesis",
      progress: 30,
      state: {
        ...context.state,
        research_scout_terminal_count: status.terminalCount,
        research_scout_completed_count: status.completedCount,
        research_scout_failed_count: status.failedCount,
        research_early_finalize: earlyFinalize,
      },
      stateReason: earlyFinalizeRequested
        ? "research_scout_fan_in_early_finalized"
        : "research_scout_fan_in_complete",
      eventType: "research.scouts_completed",
      eventPayload: {
        research_run_id: runId,
        completed_count: status.completedCount,
        failed_count: status.failedCount,
        cancelled_count: status.cancelledCount,
        finalization: earlyFinalize.finalization,
      },
      enqueueReason: "research_synthesis",
      creativeRunId: rootCreativeRunId,
    };
  }

  if (context.currentStage === "research_synthesis") {
    if (!services.researchIntelligence || !services.researchSynthesizerExecutor || !services.gameDiscoveryV2) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SYNTHESIS_NOT_CONFIGURED",
        message: "Research synthesis repository/executor is not configured",
        retryable: false,
      });
    }
    const runId = researchRunId(context);
    const synthesis = new ResearchSynthesisService(
      services.researchIntelligence,
      services.researchSynthesizerExecutor,
    );
    const earlyFinalizeRequested = record(context.state.research_early_finalize).requested === true;
    const finalization = earlyFinalizeRequested ? "early_finalized" as const : "full" as const;
    let result: ResearchSynthesisRunResult;
    try {
      result = await synthesis.run({
        researchRunId: runId,
        signal: context.signal,
        finalization,
      });
    } catch (error) {
      if (context.signal.aborted) throw error;
      const details = {
        research_run_id: runId,
        phase: "research_synthesis",
        finalization,
        completed_scout_count:
          typeof context.state.research_scout_completed_count === "number"
            ? context.state.research_scout_completed_count
            : null,
        ...boundedResearchFailureDiagnostic(error),
      };
      await services.gameDiscoveryV2.markResearchFailure({
        researchRunId: runId,
        code: "RESEARCH_SYNTHESIS_FAILED",
        message: "Research synthesis failed before a valid Evidence Pack could be persisted",
        coverage: details,
        bestEffortFallback: policy.mode === "best_effort",
      });
      if (policy.mode === "best_effort") {
        return baselineFallback({ context, reason: "synthesis_failure", details });
      }
      return terminalResearchFailure({
        context,
        code: "RESEARCH_SYNTHESIS_FAILED",
        message: "Required research could not produce a valid Evidence Pack",
        details,
      });
    }
    const coverage = researchCoverageSummary(result.pack);
    if (!coverage.useful) {
      const details = {
        research_run_id: runId,
        evidence_pack_id: result.pack.packId,
        total_evidence: coverage.totalEvidence,
        covered_scout_roles: coverage.coveredScoutRoles,
      };
      await services.gameDiscoveryV2.markResearchFailure({
        researchRunId: runId,
        code: "RESEARCH_COVERAGE_LOW",
        message: "Evidence Pack does not meet the minimum v2 grounding threshold",
        coverage: result.pack.coverage,
        bestEffortFallback: policy.mode === "best_effort",
      });
      if (policy.mode === "best_effort") {
        return baselineFallback({ context, reason: "low", details });
      }
      return terminalResearchFailure({
        context,
        code: "RESEARCH_COVERAGE_LOW",
        message: "Required research produced too little source-backed evidence to ground concepts",
        details,
      });
    }

    return {
      status: "queued",
      currentStage: "concept_council_fanout",
      progress: 42,
      state: {
        ...context.state,
        evidence_pack_id: result.pack.packId,
        research_coverage: "sufficient",
        research_coverage_summary: coverage,
        research_finalization: result.pack.finalization ?? finalization,
      },
      stateReason: result.reusedFromPersistence ? "evidence_pack_reconciled" : "evidence_pack_ready",
      eventType: "research.evidence_pack_ready",
      eventPayload: {
        research_run_id: runId,
        evidence_pack_id: result.pack.packId,
        reused_from_persistence: result.reusedFromPersistence,
        total_evidence: coverage.totalEvidence,
        covered_scout_roles: coverage.coveredScoutRoles,
        finalization: result.pack.finalization ?? finalization,
      },
      enqueueReason: "concept_council_fanout",
      creativeRunId: rootCreativeRunId,
    };
  }

  if (context.currentStage === "concept_council_fanout") {
    if (!services.conceptCouncil || !services.researchIntelligence) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_NOT_CONFIGURED",
        message: "Concept Council repository is not configured",
        retryable: false,
      });
    }
    const runId = researchRunId(context);
    const synthesisInput = await services.researchIntelligence.loadSynthesisInput(runId);
    const pack = synthesisInput.activePack;
    if (!pack) {
      throw new DurableWorkflowError({
        code: "EVIDENCE_PACK_NOT_FOUND",
        message: "Active Evidence Pack is missing before Concept Council fan-out",
        retryable: true,
      });
    }
    const parsedObjective = await import("../../lib/game-discovery/schemas").then(({ discoveryObjectiveSpecV1Schema }) =>
      discoveryObjectiveSpecV1Schema.parse(context.state.discovery_objective),
    );
    const fanout = await services.conceptCouncil.fanOut({
      researchRunId: runId,
      evidencePackId: pack.packId,
      objective: parsedObjective,
    });
    return {
      status: "waiting",
      currentStage: "waiting_concept_council",
      progress: 48,
      nextActionAt: nextAt(),
      state: {
        ...context.state,
        evidence_pack_id: pack.packId,
        concept_council_jobs: fanout.designers.map((item) => ({
          designer_role: item.designerRole,
          factory_job_id: item.factoryJobId,
          creative_run_id: item.creativeRunId,
        })),
      },
      stateReason: "waiting_for_three_concept_designers",
      eventType: "concept_council.fanned_out",
      eventPayload: {
        research_run_id: runId,
        evidence_pack_id: pack.packId,
        designer_count: fanout.designers.length,
      },
      enqueueReason: "concept_council_fan_in_poll",
      creativeRunId: rootCreativeRunId,
    };
  }

  if (context.currentStage === "waiting_concept_council") {
    if (!services.conceptCouncil) {
      throw new DurableWorkflowError({
        code: "CONCEPT_COUNCIL_NOT_CONFIGURED",
        message: "Concept Council repository is not configured",
        retryable: false,
      });
    }
    const runId = researchRunId(context);
    const status = await services.conceptCouncil.getFanoutStatus(runId);
    if (!status.allTerminal) {
      return {
        status: "waiting",
        currentStage: "waiting_concept_council",
        progress: Math.min(66, 48 + status.terminalCount * 6),
        nextActionAt: nextAt(),
        state: context.state,
        stateReason: `concept_designers_terminal:${status.terminalCount}/3`,
        eventType: "concept_council.waiting",
        eventPayload: {
          research_run_id: runId,
          terminal_count: status.terminalCount,
          completed_count: status.completedCount,
          failed_count: status.failedCount,
        },
        enqueueReason: "concept_council_fan_in_poll",
        creativeRunId: rootCreativeRunId,
      };
    }
    if (status.failedCount > 0 || status.completedCount !== 3) {
      return terminalResearchFailure({
        context,
        code: "CONCEPT_COUNCIL_MEMBER_FAILED",
        message: "Concept Council cannot curate six grounded cards because a Designer did not complete",
        details: {
          research_run_id: runId,
          completed_count: status.completedCount,
          failed_count: status.failedCount,
        },
      });
    }
    return {
      status: "queued",
      currentStage: "concept_curation",
      progress: 68,
      state: context.state,
      stateReason: "concept_council_fan_in_complete",
      eventType: "concept_council.designers_completed",
      eventPayload: { research_run_id: runId, completed_count: status.completedCount },
      enqueueReason: "concept_curation",
      creativeRunId: rootCreativeRunId,
    };
  }

  if (context.currentStage === "concept_curation") {
    if (
      !services.conceptCouncil ||
      !services.conceptCouncilCuratorExecutor ||
      !services.researchIntelligence ||
      !services.gameDiscoveryV2 ||
      !services.gameDiscovery
    ) {
      throw new DurableWorkflowError({
        code: "CONCEPT_CURATOR_NOT_CONFIGURED",
        message: "Concept Curator or Stage 4 handoff repository is not configured",
        retryable: false,
      });
    }
    const runId = researchRunId(context);
    const synthesisInput = await services.researchIntelligence.loadSynthesisInput(runId);
    const pack = synthesisInput.activePack ? evidencePackSpecV1Schema.parse(synthesisInput.activePack) : null;
    if (!pack) {
      throw new DurableWorkflowError({
        code: "EVIDENCE_PACK_NOT_FOUND",
        message: "Active Evidence Pack is missing before concept curation",
        retryable: true,
      });
    }
    const history = await services.gameDiscovery.getConceptHistory({
      rootCreativeRunId,
      limit: 200,
    });
    const curator = new ConceptCouncilCuratorService(
      services.conceptCouncil,
      services.conceptCouncilCuratorExecutor,
    );
    const curated = await curator.run({
      researchRunId: runId,
      evidencePack: pack,
      history,
      signal: context.signal,
    });
    const conceptRuns = await services.gameDiscoveryV2.persistCuratedConcepts({
      jobId: context.jobId,
      rootCreativeRunId,
      evidencePack: pack,
      batch: curated.batch,
      metadata: {
        provider: "research_council",
        model: "stage4_5_concept_curator_v1",
        usage: {
          raw_candidate_count: curated.rawCandidateCount,
          reused_from_persistence: curated.reusedFromPersistence,
          curated_count: curated.batch.cards.length,
        },
      },
    });
    if (conceptRuns.length !== 6) {
      throw new DurableWorkflowError({
        code: "GAME_DISCOVERY_V2_CONCEPT_PERSISTENCE_INVALID",
        message: `Expected six persisted Stage 4 concept runs, got ${conceptRuns.length}`,
        retryable: false,
      });
    }

    return {
      status: "awaiting_approval",
      currentStage: "human_concept_approval_pending",
      progress: 72,
      state: {
        ...context.state,
        curated_concept_count: 6,
        curated_concept_ids: curated.batch.cards.map((card) => card.concept.conceptId),
        concept_runs: conceptRuns,
        human_concept_gate_required: true,
        human_concept_gate_passed: false,
      },
      stateReason: "human_concept_approval_required_after_research_council",
      eventType: "human.concept_approval_required",
      eventPayload: {
        research_run_id: runId,
        evidence_pack_id: pack.packId,
        concept_count: 6,
        concept_ids: curated.batch.cards.map((card) => card.concept.conceptId),
      },
      creativeRunId: rootCreativeRunId,
    };
  }

  // Every non-v2 stage is the existing Stage 4 production path. This includes
  // baseline fallback concept generation, the concept approval/revision loop, and
  // all reference/image/video/assembly gates and handlers.
  return stage4Handoff(context);
};