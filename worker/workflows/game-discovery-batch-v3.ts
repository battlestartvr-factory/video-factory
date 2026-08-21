import { KieClaudeTaskError } from "../../lib/models/kie/claude-task";
import { DurableWorkflowError } from "../../lib/orchestrator/retry";
import {
  buildGameDiscoveryV2ResearchPlan,
  resolveResearchPolicyV1,
} from "../../lib/research-intelligence/game-discovery-v2";
import {
  buildGameDiscoveryV3ResearchPack,
  generateStrongConceptBatch,
} from "../../lib/research-intelligence/game-discovery-v3";
import {
  acquireSharedResearchSourcePool,
  sharedResearchSourcePoolV1Schema,
  type SharedResearchSourcePoolV1,
} from "../../lib/research-intelligence/shared-source-pool";
import { discoveryObjectiveSpecV1Schema } from "../../lib/game-discovery/schemas";
import { gameDiscoveryBatchStage4InspectedV1 } from "./game-discovery-batch-stage4-inspected-v1";
import type { WorkflowTickContext, WorkflowTickHandler } from "./types";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requireRuntime(context: WorkflowTickContext) {
  const services = context.services;
  if (!services?.gameDiscoveryV3 || !services.gameDiscovery || !services.kieClaude) {
    throw new DurableWorkflowError({
      code: "GAME_DISCOVERY_V3_RUNTIME_MISSING",
      message: "Game Discovery v3 requires its repository, Stage 4 repository and KIE LLM runtime",
      retryable: false,
    });
  }
  return {
    repository: services.gameDiscoveryV3,
    stage4: services.gameDiscovery,
    llm: services.kieClaude,
    progress: services.researchIntelligence,
  };
}

function retryablePersistence(code: string, error: unknown): DurableWorkflowError {
  return new DurableWorkflowError({
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    retryAfterMs: 5_000,
    cause: error,
  });
}

function providerFailure(error: KieClaudeTaskError): DurableWorkflowError {
  return new DurableWorkflowError({
    code: "STRONG_CONCEPT_PROVIDER_FAILED",
    message: error.message,
    retryable: error.retryable,
    retryAfterMs: error.retryable ? 5_000 : undefined,
    details: { http_status: error.status },
    cause: error,
  });
}

async function loadOrAcquirePool(input: {
  context: WorkflowTickContext;
  researchRunId: string;
  plan: ReturnType<typeof buildGameDiscoveryV2ResearchPlan>;
}): Promise<SharedResearchSourcePoolV1> {
  const runtime = requireRuntime(input.context);
  const current = await runtime.repository.getSharedSourcePool(input.researchRunId);
  if (current.status === "ready") {
    return sharedResearchSourcePoolV1Schema.parse(current.pool);
  }
  if (current.status === "failed") {
    const failure = object(current.error);
    throw new DurableWorkflowError({
      code: text(failure.code) ?? "RESEARCH_ACQUISITION_FAILED",
      message: text(failure.message) ?? "Verified research acquisition failed",
      retryable: false,
    });
  }

  const lease = await runtime.repository.acquireSharedSourcePool({
    researchRunId: input.researchRunId,
    jobId: input.context.jobId,
  });
  if (lease.status === "ready") {
    return sharedResearchSourcePoolV1Schema.parse(lease.pool);
  }
  if (lease.status === "failed") {
    const failure = object(lease.error);
    throw new DurableWorkflowError({
      code: text(failure.code) ?? "RESEARCH_ACQUISITION_FAILED",
      message: text(failure.message) ?? "Verified research acquisition failed",
      retryable: false,
    });
  }
  if (lease.acquired !== true) {
    throw new DurableWorkflowError({
      code: "RESEARCH_ACQUISITION_BUSY",
      message: "Research source acquisition is already in progress",
      retryable: true,
      retryAfterMs: 2_000,
    });
  }

  let pool: SharedResearchSourcePoolV1;
  try {
    pool = await acquireSharedResearchSourcePool({
      researchRunId: input.researchRunId,
      ownerJobId: input.context.jobId,
      plan: input.plan,
      signal: input.context.signal,
      reportProgress: async (event) => {
        if (!runtime.progress) return;
        await runtime.progress.recordProgressEvent({
          rootFactoryJobId: input.context.jobId,
          jobId: input.context.jobId,
          researchRunId: input.researchRunId,
          scoutRole: null,
          eventType: event.eventType,
          dedupeKey: `v3:${input.context.jobId}:${event.key}`,
          payload: {
            ...(event.payload ?? {}),
            architecture: "simplified_v3",
          },
        });
      },
    });
    await runtime.repository.completeSharedSourcePool({
      researchRunId: input.researchRunId,
      jobId: input.context.jobId,
      pool,
    });
  } catch (error) {
    if (input.context.signal.aborted) throw error;
    const value = error as { code?: unknown; message?: unknown; usage?: unknown };
    const code = typeof value.code === "string" ? value.code : "RESEARCH_ACQUISITION_FAILED";
    const message = typeof value.message === "string" ? value.message : String(error);
    try {
      await runtime.repository.failSharedSourcePool({
        researchRunId: input.researchRunId,
        jobId: input.context.jobId,
        code,
        message,
        usage: object(value.usage),
      });
    } catch {
      // The original acquisition error remains authoritative.
    }
    throw new DurableWorkflowError({ code, message, retryable: false, cause: error });
  }
  return pool;
}

export const gameDiscoveryBatchV3: WorkflowTickHandler = async (context) => {
  const objectiveResult = discoveryObjectiveSpecV1Schema.safeParse(context.state.discovery_objective);
  const creativeRunId = text(context.state.creative_run_id);
  if (!objectiveResult.success || !creativeRunId) {
    return {
      status: "failed",
      currentStage: context.currentStage ?? "research_acquisition",
      progress: 0,
      error: {
        code: "DISCOVERY_OBJECTIVE_INVALID",
        message: "Game Discovery v3 is missing a valid objective or creative run id",
      },
      stateReason: "v3_invalid_discovery_admission_state",
      eventType: "discovery.v3_objective_invalid",
    };
  }

  const objective = objectiveResult.data;

  if (!context.currentStage || context.currentStage === "research_acquisition") {
    const runtime = requireRuntime(context);
    const rawPolicy = object(context.state.research_policy);
    const policy = resolveResearchPolicyV1(rawPolicy as never);
    if (policy.mode === "disabled") {
      throw new DurableWorkflowError({
        code: "GAME_DISCOVERY_V3_RESEARCH_REQUIRED",
        message: "Simplified v3 requires bounded research acquisition before concept synthesis",
        retryable: false,
      });
    }

    let researchRun;
    let plan;
    try {
      const provisionalId = text(context.state.research_run_id) ?? crypto.randomUUID();
      plan = buildGameDiscoveryV2ResearchPlan({ researchRunId: provisionalId, objective, policy });
      researchRun = await runtime.repository.beginResearch({
        jobId: context.jobId,
        rootCreativeRunId: creativeRunId,
        objective,
        researchPolicy: policy,
        plan,
      });
      if (plan.researchRunId !== researchRun.researchRunId) {
        plan = buildGameDiscoveryV2ResearchPlan({
          researchRunId: researchRun.researchRunId,
          objective,
          policy,
        });
        researchRun = await runtime.repository.beginResearch({
          jobId: context.jobId,
          rootCreativeRunId: creativeRunId,
          objective,
          researchPolicy: policy,
          plan,
        });
      }
    } catch (error) {
      throw retryablePersistence("V3_RESEARCH_ADMISSION_FAILED", error);
    }

    let existingPack;
    try {
      existingPack = await runtime.repository.getResearchPack({ rootCreativeRunId: creativeRunId });
    } catch (error) {
      throw retryablePersistence("V3_RESEARCH_PACK_RESUME_FAILED", error);
    }
    if (existingPack) {
      const now = new Date().toISOString();
      return {
        status: "waiting",
        currentStage: "strong_concept_generation",
        progress: 30,
        nextActionAt: now,
        enqueueReason: "strong_concept_generation",
        state: {
          ...context.state,
          research_run_id: existingPack.researchRunId,
          research_pack_ready: true,
          research_source_count: existingPack.sources.length,
        },
        stateReason: "v3_research_pack_resumed",
        eventType: "discovery.v3_research_ready",
      };
    }

    let pool;
    try {
      pool = await loadOrAcquirePool({ context, researchRunId: researchRun.researchRunId, plan });
    } catch (error) {
      if (error instanceof DurableWorkflowError) throw error;
      throw retryablePersistence("V3_RESEARCH_ACQUISITION_FAILED", error);
    }
    const pack = buildGameDiscoveryV3ResearchPack({ objectiveId: objective.objectiveId, pool });
    try {
      await runtime.repository.persistResearchPack({
        jobId: context.jobId,
        rootCreativeRunId: creativeRunId,
        pack,
      });
    } catch (error) {
      throw retryablePersistence("V3_RESEARCH_PACK_PERSIST_FAILED", error);
    }

    const now = new Date().toISOString();
    return {
      status: "waiting",
      currentStage: "strong_concept_generation",
      progress: 30,
      nextActionAt: now,
      enqueueReason: "strong_concept_generation",
      state: {
        ...context.state,
        research_run_id: researchRun.researchRunId,
        research_pack_ready: true,
        research_source_count: pack.sources.length,
        research_coverage: pack.coverage,
        research_completed_at: now,
        simplified_creative_graph: true,
      },
      stateReason: "v3_bounded_research_complete",
      eventType: "discovery.v3_research_ready",
      eventPayload: {
        research_run_id: researchRun.researchRunId,
        source_count: pack.sources.length,
        coverage: pack.coverage,
        architecture: "research_pack_then_one_strong_llm",
      },
    };
  }

  if (context.currentStage === "strong_concept_generation") {
    const runtime = requireRuntime(context);
    let persisted;
    try {
      persisted = await runtime.stage4.getConceptStage({ rootCreativeRunId: creativeRunId });
    } catch (error) {
      throw retryablePersistence("V3_CONCEPT_RESUME_CHECK_FAILED", error);
    }
    if (persisted.persisted && persisted.acceptedConcepts.length) {
      return {
        status: "waiting",
        currentStage: "human_concept_approval_pending",
        progress: 40,
        nextActionAt: null,
        state: {
          ...context.state,
          concept_ids: persisted.acceptedConcepts.map((concept) => concept.conceptId),
          concept_run_ids: persisted.conceptRuns.map((run) => run.runId),
          human_concept_gate_required: true,
          human_concept_gate_passed: false,
        },
        stateReason: "v3_concepts_resumed_waiting_for_human",
        eventType: "discovery.v3_concepts_ready_for_review",
      };
    }

    let pack;
    try {
      pack = await runtime.repository.getResearchPack({ rootCreativeRunId: creativeRunId });
    } catch (error) {
      throw retryablePersistence("V3_RESEARCH_PACK_LOAD_FAILED", error);
    }
    if (!pack) {
      return {
        status: "waiting",
        currentStage: "research_acquisition",
        progress: 10,
        nextActionAt: new Date().toISOString(),
        enqueueReason: "research_pack_missing",
        state: context.state,
        stateReason: "v3_research_pack_missing",
      };
    }

    let generated;
    try {
      generated = await generateStrongConceptBatch({
        llm: runtime.llm,
        objective,
        pack,
        model: "gpt-5-6-terra",
        signal: context.signal,
      });
    } catch (error) {
      if (error instanceof KieClaudeTaskError) throw providerFailure(error);
      if (context.signal.aborted) throw error;
      throw new DurableWorkflowError({
        code: "STRONG_CONCEPT_GENERATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        cause: error,
      });
    }

    let conceptRuns;
    try {
      conceptRuns = await runtime.repository.persistConcepts({
        jobId: context.jobId,
        rootCreativeRunId: creativeRunId,
        pack,
        result: generated,
      });
    } catch (error) {
      throw retryablePersistence("V3_CONCEPT_PERSIST_FAILED", error);
    }

    return {
      status: "waiting",
      currentStage: "human_concept_approval_pending",
      progress: 40,
      nextActionAt: null,
      state: {
        ...context.state,
        concept_ids: generated.batch.concepts.map((item) => item.concept.conceptId),
        concept_run_ids: conceptRuns.map((run) => run.runId),
        concept_count_generated: 3,
        strong_concept_model: generated.model,
        strong_concept_attempts: generated.attempts,
        strong_concept_usage: generated.usage,
        human_concept_gate_required: true,
        human_concept_gate_passed: false,
      },
      stateReason: "v3_three_concepts_ready_for_human_review",
      eventType: "discovery.v3_concepts_ready_for_review",
      eventPayload: {
        concept_count: 3,
        concept_ids: generated.batch.concepts.map((item) => item.concept.conceptId),
        model: generated.model,
        source_count: pack.sources.length,
      },
    };
  }

  // The simplified creative front-end is complete. From this point v3 reuses the
  // proven Stage 4 reliability shell: concept revise/reject semantics, gameplay moment,
  // visual references, image gate, Kling, human video gate, assembly and recovery.
  return gameDiscoveryBatchStage4InspectedV1(context);
};