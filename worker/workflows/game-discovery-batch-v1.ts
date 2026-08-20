import { exploreConcepts } from "../../lib/game-discovery/concept-explorer";
import {
  applyHumanConceptReviews,
  type HumanConceptReviewState,
} from "../../lib/game-discovery/human-concept-gate";
import { planGameplayMoments } from "../../lib/game-discovery/moment-planner";
import { preEvaluateConcepts } from "../../lib/game-discovery/pre-evaluator";
import { discoveryObjectiveSpecV1Schema } from "../../lib/game-discovery/schemas";
import { DurableWorkflowError } from "../../lib/orchestrator/retry";
import { KieClaudeTaskError } from "../../lib/models/kie/claude-task";
import type { WorkflowTickContext, WorkflowTickHandler } from "./types";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function conceptReviewsFromState(state: Record<string, unknown>): HumanConceptReviewState[] {
  return Object.values(object(state.concept_reviews))
    .map((value) => {
      const row = object(value);
      const conceptRunId = text(row.conceptRunId);
      const conceptId = text(row.conceptId);
      const decision = text(row.decision);
      if (
        !conceptRunId ||
        !conceptId ||
        (decision !== "approve" && decision !== "revise" && decision !== "reject")
      ) {
        return null;
      }
      return {
        conceptRunId,
        conceptId,
        decision,
        rawFeedback: text(row.rawFeedback),
        reviewId: text(row.reviewId),
      } satisfies HumanConceptReviewState;
    })
    .filter((review): review is HumanConceptReviewState => review !== null);
}

function retainedApprovalState(
  state: Record<string, unknown>,
  activeConceptIds: Set<string>,
): Record<string, unknown> {
  const retained: Record<string, unknown> = {};
  for (const [runId, value] of Object.entries(object(state.concept_reviews))) {
    const row = object(value);
    const conceptId = text(row.conceptId);
    if (row.decision === "approve" && conceptId && activeConceptIds.has(conceptId)) {
      retained[runId] = value;
    }
  }
  return retained;
}

function requireDiscoveryRuntime(context: WorkflowTickContext) {
  if (!context.services) {
    throw new DurableWorkflowError({
      code: "DISCOVERY_RUNTIME_MISSING",
      message: "game_discovery_batch@1 requires durable worker services",
      retryable: false,
    });
  }
  if (!context.services.gameDiscovery) {
    throw new DurableWorkflowError({
      code: "DISCOVERY_REPOSITORY_MISSING",
      message: "Stage 4 game discovery repository is not configured in the durable worker",
      retryable: false,
    });
  }
  if (!context.services.kieClaude) {
    throw new DurableWorkflowError({
      code: "KIE_NOT_CONFIGURED",
      message: "KIE_API_KEY is required for Stage 4 discovery reasoning",
      retryable: false,
    });
  }
  return {
    repository: context.services.gameDiscovery,
    claude: context.services.kieClaude,
  };
}

function providerFailure(error: KieClaudeTaskError, stage: string): DurableWorkflowError {
  return new DurableWorkflowError({
    code: `${stage}_PROVIDER_FAILED`,
    message: error.message,
    retryable: error.retryable,
    retryAfterMs: error.retryable ? 5_000 : undefined,
    details: { http_status: error.status },
    cause: error,
  });
}

function retryablePersistenceError(code: string, error: unknown): DurableWorkflowError {
  return new DurableWorkflowError({
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    retryAfterMs: 5_000,
    cause: error,
  });
}

export const gameDiscoveryBatchV1: WorkflowTickHandler = async (context) => {
  const objectiveResult = discoveryObjectiveSpecV1Schema.safeParse(context.state.discovery_objective);
  const creativeRunId = text(context.state.creative_run_id);

  if (!objectiveResult.success || !creativeRunId) {
    return {
      status: "failed",
      currentStage: context.currentStage ?? "objective_ready",
      progress: 0,
      error: {
        code: "DISCOVERY_OBJECTIVE_INVALID",
        message: "Durable discovery job is missing a valid objective or creative run id",
      },
      stateReason: "invalid_discovery_admission_state",
      eventType: "discovery.objective_invalid",
    };
  }

  if (!context.currentStage || context.currentStage === "objective_ready") {
    const now = new Date().toISOString();
    return {
      status: "waiting",
      currentStage: "concept_generation_pending",
      progress: 10,
      nextActionAt: now,
      enqueueReason: "concept_generation",
      state: {
        ...context.state,
        creative_run_id: creativeRunId,
        discovery_objective: objectiveResult.data,
        objective_validated_at: now,
        stage4_schema_version: 1,
        human_concept_gate_required: true,
        human_concept_gate_passed: false,
      },
      stateReason: "s4_002_ready_for_concept_explorer",
      eventType: "discovery.objective_ready",
      eventPayload: {
        creative_run_id: creativeRunId,
        objective_id: objectiveResult.data.objectiveId,
        concept_count: objectiveResult.data.conceptCount,
        max_concepts_to_prototype: objectiveResult.data.maxConceptsToPrototype,
      },
    };
  }

  if (context.currentStage === "concept_generation_pending") {
    const runtime = requireDiscoveryRuntime(context);

    let persisted;
    try {
      persisted = await runtime.repository.getConceptStage({ rootCreativeRunId: creativeRunId });
    } catch (error) {
      throw retryablePersistenceError("CONCEPT_STAGE_RESUME_CHECK_FAILED", error);
    }

    if (persisted.persisted) {
      const now = new Date().toISOString();
      return {
        status: "waiting",
        currentStage: "human_concept_approval_pending",
        progress: 35,
        nextActionAt: null,
        state: {
          ...context.state,
          concept_ids: persisted.acceptedConcepts.map((concept) => concept.conceptId),
          concept_run_ids: persisted.conceptRuns.map((run) => run.runId),
          concept_count_accepted: persisted.acceptedConcepts.length,
          concept_count_rejected: persisted.rejectionCount,
          concept_explorer: persisted.explorerMetadata,
          concept_generation_completed_at:
            text(context.state.concept_generation_completed_at) ?? now,
          human_concept_gate_required: true,
          human_concept_gate_passed: false,
          concept_reviews: object(context.state.concept_reviews),
        },
        stateReason: "s4_003_resumed_waiting_for_human_concept_review",
        eventType: "discovery.concepts_ready_for_review",
        eventPayload: {
          creative_run_id: creativeRunId,
          accepted_count: persisted.acceptedConcepts.length,
          concept_run_ids: persisted.conceptRuns.map((run) => run.runId),
        },
      };
    }

    let history;
    try {
      history = await runtime.repository.getConceptHistory({
        rootCreativeRunId: creativeRunId,
        limit: 200,
      });
    } catch (error) {
      throw retryablePersistenceError("CONCEPT_HISTORY_LOAD_FAILED", error);
    }

    let exploration;
    try {
      exploration = await exploreConcepts({
        llm: runtime.claude,
        objective: objectiveResult.data,
        history,
        model: "claude-sonnet-5",
        replacementBuffer: 2,
        maxReplacementAttempts: 3,
        signal: context.signal,
      });
    } catch (error) {
      if (error instanceof KieClaudeTaskError) throw providerFailure(error, "CONCEPT_EXPLORER");
      if (context.signal.aborted) throw error;
      throw new DurableWorkflowError({
        code: "CONCEPT_EXPLORER_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        cause: error,
      });
    }

    let conceptRuns;
    try {
      conceptRuns = await runtime.repository.persistConceptExploration({
        jobId: context.jobId,
        rootCreativeRunId: creativeRunId,
        result: exploration,
      });
    } catch (error) {
      // A commit can succeed before the RPC transport fails. The next tick reconciles DB state first.
      throw retryablePersistenceError("CONCEPT_EXPLORATION_PERSIST_FAILED", error);
    }

    const completedAt = new Date().toISOString();
    return {
      status: "waiting",
      currentStage: "human_concept_approval_pending",
      progress: 35,
      nextActionAt: null,
      state: {
        ...context.state,
        concept_ids: exploration.accepted.map((concept) => concept.conceptId),
        concept_run_ids: conceptRuns.map((run) => run.runId),
        concept_count_generated: exploration.generatedCount,
        concept_count_accepted: exploration.accepted.length,
        concept_count_rejected: exploration.rejected.length,
        concept_replacement_attempts: exploration.replacementAttempts,
        concept_generation_completed_at: completedAt,
        concept_explorer: {
          model: exploration.model,
          usage: exploration.usage,
          raw_response_hashes: exploration.rawResponseHashes,
        },
        human_concept_gate_required: true,
        human_concept_gate_passed: false,
        concept_reviews: {},
      },
      stateReason: "s4_003_concepts_ready_for_human_review",
      eventType: "discovery.concepts_ready_for_review",
      eventPayload: {
        creative_run_id: creativeRunId,
        objective_id: objectiveResult.data.objectiveId,
        generated_count: exploration.generatedCount,
        accepted_count: exploration.accepted.length,
        rejected_count: exploration.rejected.length,
        replacement_attempts: exploration.replacementAttempts,
        concept_ids: exploration.accepted.map((concept) => concept.conceptId),
        concept_run_ids: conceptRuns.map((run) => run.runId),
        history_count: history.length,
        model: exploration.model,
        usage: exploration.usage,
      },
    };
  }

  if (context.currentStage === "human_concept_approval_pending") {
    const runtime = requireDiscoveryRuntime(context);
    let concepts;
    try {
      concepts = await runtime.repository.getConceptStage({ rootCreativeRunId: creativeRunId });
    } catch (error) {
      throw retryablePersistenceError("CONCEPT_APPROVAL_RECONCILE_FAILED", error);
    }

    if (!concepts.persisted || !concepts.acceptedConcepts.length) {
      throw new DurableWorkflowError({
        code: "CONCEPT_APPROVAL_CONCEPTS_MISSING",
        message: "Human concept approval requires persisted active concepts",
        retryable: false,
      });
    }

    const runByConceptId = new Map(concepts.conceptRuns.map((run) => [run.conceptId, run]));
    const reviews = conceptReviewsFromState(context.state);
    const reviewByRunId = new Map(reviews.map((review) => [review.conceptRunId, review]));
    const activeRows = concepts.acceptedConcepts.map((concept) => {
      const run = runByConceptId.get(concept.conceptId);
      if (!run) {
        throw new DurableWorkflowError({
          code: "CONCEPT_APPROVAL_RUN_MISSING",
          message: `Active concept ${concept.conceptId} has no persisted concept run`,
          retryable: false,
        });
      }
      return { concept, run, review: reviewByRunId.get(run.runId) ?? null };
    });

    if (!activeRows.every((item) => item.review !== null)) {
      return {
        status: "waiting",
        currentStage: "human_concept_approval_pending",
        progress: 35,
        nextActionAt: null,
        state: {
          ...context.state,
          human_concept_gate_required: true,
          human_concept_gate_passed: false,
          concept_ids: concepts.acceptedConcepts.map((concept) => concept.conceptId),
          concept_run_ids: activeRows.map((item) => item.run.runId),
        },
        stateReason: "s4_003_waiting_for_human_concept_review",
        eventType: "discovery.waiting_for_concept_review",
        eventPayload: {
          reviewed_count: activeRows.filter((item) => item.review !== null).length,
          expected_count: activeRows.length,
        },
      };
    }

    const changed = activeRows.filter(
      (item) => item.review?.decision === "revise" || item.review?.decision === "reject",
    );
    if (changed.length) {
      const now = new Date().toISOString();
      return {
        status: "waiting",
        currentStage: "concept_revision_pending",
        progress: 37,
        nextActionAt: now,
        enqueueReason: "human_concept_regeneration",
        state: {
          ...context.state,
          human_concept_gate_required: true,
          human_concept_gate_passed: false,
          concept_ids: concepts.acceptedConcepts.map((concept) => concept.conceptId),
          concept_run_ids: activeRows.map((item) => item.run.runId),
        },
        stateReason: "s4_003_human_concept_changes_requested",
        eventType: "discovery.concept_changes_requested",
        eventPayload: {
          revise_concept_ids: changed
            .filter((item) => item.review?.decision === "revise")
            .map((item) => item.concept.conceptId),
          reject_concept_ids: changed
            .filter((item) => item.review?.decision === "reject")
            .map((item) => item.concept.conceptId),
        },
      };
    }

    const now = new Date().toISOString();
    return {
      status: "waiting",
      currentStage: "pre_evaluation_pending",
      progress: 40,
      nextActionAt: now,
      enqueueReason: "concept_pre_evaluation",
      state: {
        ...context.state,
        human_concept_gate_required: true,
        human_concept_gate_passed: true,
        human_concept_gate_passed_at: now,
        human_approved_concept_ids: concepts.acceptedConcepts.map((concept) => concept.conceptId),
        concept_ids: concepts.acceptedConcepts.map((concept) => concept.conceptId),
        concept_run_ids: activeRows.map((item) => item.run.runId),
      },
      stateReason: "s4_003_human_concept_gate_passed",
      eventType: "discovery.concept_gate_passed",
      eventPayload: {
        approved_concept_ids: concepts.acceptedConcepts.map((concept) => concept.conceptId),
      },
    };
  }

  if (context.currentStage === "concept_revision_pending") {
    const runtime = requireDiscoveryRuntime(context);
    let concepts;
    let history;
    try {
      [concepts, history] = await Promise.all([
        runtime.repository.getConceptStage({ rootCreativeRunId: creativeRunId }),
        runtime.repository.getConceptHistory({ rootCreativeRunId: creativeRunId, limit: 200 }),
      ]);
    } catch (error) {
      throw retryablePersistenceError("HUMAN_CONCEPT_REGENERATION_CONTEXT_FAILED", error);
    }

    const runByConceptId = new Map(concepts.conceptRuns.map((run) => [run.conceptId, run]));
    const reviews = conceptReviewsFromState(context.state).filter((review) =>
      concepts.acceptedConcepts.some((concept) => concept.conceptId === review.conceptId),
    );
    const reviewsByRunId = new Map(reviews.map((review) => [review.conceptRunId, review]));
    const completeReviews = concepts.acceptedConcepts.map((concept) => {
      const run = runByConceptId.get(concept.conceptId);
      return run ? reviewsByRunId.get(run.runId) ?? null : null;
    });

    if (completeReviews.some((review) => review === null)) {
      return {
        status: "waiting",
        currentStage: "human_concept_approval_pending",
        progress: 35,
        nextActionAt: null,
        state: context.state,
        stateReason: "s4_003_human_concept_regeneration_missing_review",
      };
    }

    let regenerated;
    try {
      regenerated = await applyHumanConceptReviews({
        llm: runtime.claude,
        objective: objectiveResult.data,
        activeConcepts: concepts.acceptedConcepts,
        reviews: completeReviews as HumanConceptReviewState[],
        history,
        model: "claude-sonnet-5",
        signal: context.signal,
      });
    } catch (error) {
      if (error instanceof KieClaudeTaskError) throw providerFailure(error, "HUMAN_CONCEPT_GATE");
      if (context.signal.aborted) throw error;
      throw new DurableWorkflowError({
        code: "HUMAN_CONCEPT_REGENERATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        cause: error,
      });
    }

    let conceptRuns;
    try {
      conceptRuns = await runtime.repository.persistConceptExploration({
        jobId: context.jobId,
        rootCreativeRunId: creativeRunId,
        result: {
          accepted: regenerated.activeConcepts,
          rejected: [],
          requestedCount: concepts.acceptedConcepts.length,
          generatedCount: regenerated.regeneratedConcepts.length,
          replacementAttempts: regenerated.attempts,
          model: regenerated.model,
          rawResponseHashes: regenerated.rawResponseHashes,
          usage: regenerated.usage,
        },
      });
    } catch (error) {
      throw retryablePersistenceError("HUMAN_CONCEPT_REGENERATION_PERSIST_FAILED", error);
    }

    const activeConceptIds = new Set(regenerated.activeConcepts.map((concept) => concept.conceptId));
    const retainedReviews = retainedApprovalState(context.state, activeConceptIds);
    const changedReviews = reviews.filter(
      (review) => review.decision === "revise" || review.decision === "reject",
    );

    return {
      status: "waiting",
      currentStage: "human_concept_approval_pending",
      progress: 38,
      nextActionAt: null,
      state: {
        ...context.state,
        concept_ids: regenerated.activeConcepts.map((concept) => concept.conceptId),
        concept_run_ids: conceptRuns.map((run) => run.runId),
        concept_reviews: retainedReviews,
        human_concept_gate_required: true,
        human_concept_gate_passed: false,
        human_concept_regeneration: {
          model: regenerated.model,
          usage: regenerated.usage,
          raw_response_hashes: regenerated.rawResponseHashes,
          attempts: regenerated.attempts,
        },
      },
      stateReason: "s4_003_human_concepts_regenerated_waiting_for_review",
      eventType: "discovery.concepts_regenerated_for_review",
      eventPayload: {
        active_concept_ids: regenerated.activeConcepts.map((concept) => concept.conceptId),
        regenerated_concept_ids: regenerated.regeneratedConcepts.map((concept) => concept.conceptId),
        revised_count: changedReviews.filter((review) => review.decision === "revise").length,
        replaced_count: changedReviews.filter((review) => review.decision === "reject").length,
      },
    };
  }

  if (context.currentStage === "pre_evaluation_pending") {
    if (
      context.state.human_concept_gate_required === true &&
      context.state.human_concept_gate_passed !== true
    ) {
      return {
        status: "waiting",
        currentStage: "human_concept_approval_pending",
        progress: 35,
        nextActionAt: null,
        state: context.state,
        stateReason: "s4_003_pre_evaluation_blocked_by_human_concept_gate",
        eventType: "discovery.pre_evaluation_blocked_by_concept_gate",
      };
    }

    const runtime = requireDiscoveryRuntime(context);
    let planning;
    let concepts;
    try {
      [planning, concepts] = await Promise.all([
        runtime.repository.getPlanningStage({ rootCreativeRunId: creativeRunId }),
        runtime.repository.getConceptStage({ rootCreativeRunId: creativeRunId }),
      ]);
    } catch (error) {
      throw retryablePersistenceError("PRE_EVALUATION_RESUME_CHECK_FAILED", error);
    }

    if (planning.preEvaluations.length > 0) {
      if (planning.selectedConceptIds.length === 0) {
        return {
          status: "completed",
          currentStage: "pre_evaluation_complete_no_candidates",
          progress: 100,
          state: {
            ...context.state,
            concept_pre_evaluations: planning.preEvaluations,
            selected_concept_ids: [],
            pre_evaluation: planning.preEvaluationMetadata,
          },
          result: {
            accepted_concepts: concepts.acceptedConcepts.length,
            prototype_candidates: 0,
            reason: "no_concepts_passed_pre_evaluation",
          },
          stateReason: "s4_004_no_concepts_passed_pre_evaluation",
          eventType: "discovery.pre_evaluation_no_candidates",
        };
      }

      const now = new Date().toISOString();
      return {
        status: "waiting",
        currentStage: "planning_moments_pending",
        progress: 50,
        nextActionAt: now,
        enqueueReason: "gameplay_moment_planning",
        state: {
          ...context.state,
          concept_pre_evaluations: planning.preEvaluations,
          selected_concept_ids: planning.selectedConceptIds,
          pre_evaluation: planning.preEvaluationMetadata,
        },
        stateReason: "s4_004_resumed_from_persisted_pre_evaluations",
        eventType: "discovery.pre_evaluations_resumed",
      };
    }

    if (!concepts.persisted || concepts.acceptedConcepts.length === 0) {
      throw new DurableWorkflowError({
        code: "PRE_EVALUATION_CONCEPTS_MISSING",
        message: "Concept pre-evaluation requires persisted accepted concepts",
        retryable: false,
      });
    }

    let preEvaluation;
    try {
      preEvaluation = await preEvaluateConcepts({
        llm: runtime.claude,
        objective: objectiveResult.data,
        concepts: concepts.acceptedConcepts,
        model: "claude-haiku-4-5",
        signal: context.signal,
      });
    } catch (error) {
      if (error instanceof KieClaudeTaskError) throw providerFailure(error, "CONCEPT_PRE_EVALUATOR");
      if (context.signal.aborted) throw error;
      throw new DurableWorkflowError({
        code: "CONCEPT_PRE_EVALUATOR_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        cause: error,
      });
    }

    const selectedConceptIds = concepts.acceptedConcepts
      .map((concept) => concept.conceptId)
      .filter((conceptId) => preEvaluation.passingConceptIds.includes(conceptId))
      .slice(0, objectiveResult.data.maxConceptsToPrototype);

    try {
      await runtime.repository.persistPreEvaluations({
        jobId: context.jobId,
        rootCreativeRunId: creativeRunId,
        result: preEvaluation,
        selectedConceptIds,
      });
    } catch (error) {
      throw retryablePersistenceError("CONCEPT_PRE_EVALUATION_PERSIST_FAILED", error);
    }

    if (selectedConceptIds.length === 0) {
      return {
        status: "completed",
        currentStage: "pre_evaluation_complete_no_candidates",
        progress: 100,
        state: {
          ...context.state,
          concept_pre_evaluations: preEvaluation.evaluations,
          selected_concept_ids: [],
          pre_evaluation: {
            model: preEvaluation.model,
            usage: preEvaluation.usage,
            raw_response_hashes: preEvaluation.rawResponseHashes,
          },
        },
        result: {
          accepted_concepts: concepts.acceptedConcepts.length,
          prototype_candidates: 0,
          reason: "no_concepts_passed_pre_evaluation",
        },
        stateReason: "s4_004_no_concepts_passed_pre_evaluation",
        eventType: "discovery.pre_evaluation_no_candidates",
      };
    }

    const completedAt = new Date().toISOString();
    return {
      status: "waiting",
      currentStage: "planning_moments_pending",
      progress: 50,
      nextActionAt: completedAt,
      enqueueReason: "gameplay_moment_planning",
      state: {
        ...context.state,
        concept_pre_evaluations: preEvaluation.evaluations,
        selected_concept_ids: selectedConceptIds,
        pre_evaluation_completed_at: completedAt,
        pre_evaluation: {
          model: preEvaluation.model,
          usage: preEvaluation.usage,
          raw_response_hashes: preEvaluation.rawResponseHashes,
          passing_concept_ids: preEvaluation.passingConceptIds,
        },
      },
      stateReason: "s4_004_pre_evaluation_complete",
      eventType: "discovery.pre_evaluations_ready",
      eventPayload: {
        evaluated_count: preEvaluation.evaluations.length,
        passing_count: preEvaluation.passingConceptIds.length,
        selected_concept_ids: selectedConceptIds,
        model: preEvaluation.model,
        usage: preEvaluation.usage,
      },
    };
  }

  if (context.currentStage === "planning_moments_pending") {
    const runtime = requireDiscoveryRuntime(context);
    let planning;
    let conceptStage;
    try {
      [planning, conceptStage] = await Promise.all([
        runtime.repository.getPlanningStage({ rootCreativeRunId: creativeRunId }),
        runtime.repository.getConceptStage({ rootCreativeRunId: creativeRunId }),
      ]);
    } catch (error) {
      throw retryablePersistenceError("GAMEPLAY_MOMENT_RESUME_CHECK_FAILED", error);
    }

    const selectedConceptIds = planning.selectedConceptIds.length
      ? planning.selectedConceptIds
      : Array.isArray(context.state.selected_concept_ids)
        ? context.state.selected_concept_ids.filter((value): value is string => typeof value === "string")
        : [];

    if (planning.moments.length > 0) {
      return {
        status: "waiting",
        currentStage: "shot_planning_pending",
        progress: 65,
        nextActionAt: null,
        state: {
          ...context.state,
          selected_concept_ids: selectedConceptIds,
          gameplay_moments: planning.moments,
          moment_planner: planning.momentPlannerMetadata,
        },
        stateReason: "s4_004_resumed_from_persisted_gameplay_moments",
        eventType: "discovery.gameplay_moments_resumed",
      };
    }

    if (!selectedConceptIds.length) {
      throw new DurableWorkflowError({
        code: "GAMEPLAY_MOMENT_SELECTION_MISSING",
        message: "Gameplay Moment Planner requires selected concept IDs from pre-evaluation",
        retryable: false,
      });
    }

    const selectedConcepts = selectedConceptIds.map((conceptId) => {
      const concept = conceptStage.acceptedConcepts.find((item) => item.conceptId === conceptId);
      if (!concept) {
        throw new DurableWorkflowError({
          code: "GAMEPLAY_MOMENT_CONCEPT_MISSING",
          message: `Selected concept ${conceptId} is missing from persisted concept stage`,
          retryable: false,
        });
      }
      return concept;
    });

    let momentPlanning;
    try {
      momentPlanning = await planGameplayMoments({
        llm: runtime.claude,
        objective: objectiveResult.data,
        concepts: selectedConcepts,
        model: "claude-sonnet-5",
        signal: context.signal,
      });
    } catch (error) {
      if (error instanceof KieClaudeTaskError) throw providerFailure(error, "GAMEPLAY_MOMENT_PLANNER");
      if (context.signal.aborted) throw error;
      throw new DurableWorkflowError({
        code: "GAMEPLAY_MOMENT_PLANNER_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        cause: error,
      });
    }

    try {
      await runtime.repository.persistGameplayMoments({
        jobId: context.jobId,
        rootCreativeRunId: creativeRunId,
        result: momentPlanning,
      });
    } catch (error) {
      throw retryablePersistenceError("GAMEPLAY_MOMENT_PERSIST_FAILED", error);
    }

    const completedAt = new Date().toISOString();
    return {
      status: "waiting",
      currentStage: "shot_planning_pending",
      progress: 65,
      nextActionAt: null,
      state: {
        ...context.state,
        selected_concept_ids: selectedConceptIds,
        gameplay_moments: momentPlanning.moments,
        gameplay_moment_planning_completed_at: completedAt,
        moment_planner: {
          model: momentPlanning.model,
          usage: momentPlanning.usage,
          raw_response_hashes: momentPlanning.rawResponseHashes,
        },
      },
      stateReason: "s4_004_gameplay_moments_ready",
      eventType: "discovery.gameplay_moments_ready",
      eventPayload: {
        selected_concept_ids: selectedConceptIds,
        moment_ids: momentPlanning.moments.map((moment) => moment.momentId),
        model: momentPlanning.model,
        usage: momentPlanning.usage,
      },
    };
  }

  if (context.currentStage === "shot_planning_pending") {
    return {
      status: "waiting",
      currentStage: "shot_planning_pending",
      progress: Math.max(65, Number(context.state.progress ?? 65)),
      nextActionAt: null,
      state: context.state,
      stateReason: "s4_004_shot_planner_not_enabled_yet",
    };
  }

  return {
    status: "failed",
    currentStage: context.currentStage,
    progress: 10,
    error: {
      code: "DISCOVERY_STAGE_UNSUPPORTED",
      message: `Unsupported game discovery stage: ${context.currentStage}`,
    },
    stateReason: "unsupported_discovery_stage",
    eventType: "discovery.stage_unsupported",
  };
};