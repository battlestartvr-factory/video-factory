import { createHash } from "node:crypto";
import { compileGameplayPromptPlans } from "../../lib/game-discovery/prompt-compiler";
import {
  stage4GameplayReferenceSetSchema,
  type Stage4GameplayReferenceSet,
} from "../../lib/game-discovery/gameplay-reference-stage4";
import {
  coopGameConceptSpecV1Schema,
  gameplayMomentSpecV1Schema,
  shotSpecV1Schema,
  type CoopGameConceptSpecV1,
  type GameplayMomentSpecV1,
  type ShotSpecV1,
} from "../../lib/game-discovery/schemas";
import { DurableWorkflowError } from "../../lib/orchestrator/retry";
import { gameDiscoveryBatchStage4DurableV1 } from "./game-discovery-batch-stage4-durable-v1";
import type { WorkflowTickContext, WorkflowTickHandler, WorkflowTickOutcome } from "./types";

const REFERENCE_POLL_MS = 5_000;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function stableUuid(seed: string): string {
  const bytes = Buffer.from(createHash("sha256").update(seed).digest("hex").slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function internalBaseUrl(): string {
  return (process.env.WORKER_APP_INTERNAL_URL ?? "http://app:3000").trim() || "http://app:3000";
}

function serviceToken(): string {
  const token = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? "").trim();
  if (!token) throw new Error("GAMEPLAY_REFERENCE_STAGE4_SERVICE_TOKEN_MISSING");
  return token;
}

async function callStage4ReferenceService<T>(body: Record<string, unknown>, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${internalBaseUrl()}/api/internal/gameplay-reference-stage4`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  const raw = await response.text();
  let payload: { ok?: boolean; code?: string; message?: string; data?: T } = {};
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    // Keep errors deterministic; do not expose an upstream HTML body.
  }
  if (!response.ok || payload.ok !== true || !payload.data) {
    throw new Error(
      `${payload.code ?? "GAMEPLAY_REFERENCE_STAGE4_UPSTREAM_FAILED"}:${payload.message ?? response.status}`,
    );
  }
  return payload.data;
}

async function retrieveReferenceSet(input: {
  concept: CoopGameConceptSpecV1;
  moment: GameplayMomentSpecV1;
  shot: ShotSpecV1;
  signal: AbortSignal;
}): Promise<Stage4GameplayReferenceSet> {
  const data = await callStage4ReferenceService<{ referenceSet: unknown }>(
    {
      action: "retrieve",
      concept: input.concept,
      moment: input.moment,
      shot: input.shot,
    },
    input.signal,
  );
  return stage4GameplayReferenceSetSchema.parse(data.referenceSet);
}

function referenceSetFromPromptMetadata(metadata: Record<string, unknown> | undefined) {
  const parsed = stage4GameplayReferenceSetSchema.safeParse(metadata?.gameplay_reference_set);
  return parsed.success ? parsed.data : null;
}

function repository(context: WorkflowTickContext) {
  const value = context.services?.gameDiscovery;
  if (!value) {
    throw new DurableWorkflowError({
      code: "DISCOVERY_REFERENCE_REPOSITORY_MISSING",
      message: "Stage 4 gameplay-reference integration requires gameDiscovery repository",
      retryable: false,
    });
  }
  return value;
}

function persistenceError(code: string, error: unknown): DurableWorkflowError {
  return new DurableWorkflowError({
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    retryAfterMs: 5_000,
    cause: error,
  });
}

async function ensurePromptReferenceSets(
  context: WorkflowTickContext,
  outcome: WorkflowTickOutcome,
): Promise<WorkflowTickOutcome> {
  if (
    outcome.status !== "waiting" ||
    outcome.currentStage !== "reference_image_generation_pending"
  ) {
    return outcome;
  }

  const rootCreativeRunId = text(outcome.state?.creative_run_id ?? context.state.creative_run_id);
  if (!rootCreativeRunId) return outcome;
  const repo = repository(context);

  let visual;
  let planning;
  let concepts;
  let feedback;
  try {
    [visual, planning, concepts, feedback] = await Promise.all([
      repo.getVisualStage({ rootCreativeRunId }),
      repo.getPlanningStage({ rootCreativeRunId }),
      repo.getConceptStage({ rootCreativeRunId }),
      repo.getFeedbackMemory({ rootCreativeRunId }),
    ]);
  } catch (error) {
    throw persistenceError("GAMEPLAY_REFERENCE_CONTEXT_LOAD_FAILED", error);
  }

  if (!visual.shots.length || visual.promptPlans.length !== visual.shots.length) return outcome;
  const alreadyIntegrated = visual.promptPlans.every((plan) =>
    Boolean(referenceSetFromPromptMetadata(plan.metadata)),
  );
  if (alreadyIntegrated) return outcome;

  const momentById = new Map(planning.moments.map((moment) => [moment.momentId, moment]));
  const conceptById = new Map(concepts.acceptedConcepts.map((concept) => [concept.conceptId, concept]));
  const referenceSets: Record<string, Stage4GameplayReferenceSet> = {};

  for (const shot of visual.shots) {
    const moment = momentById.get(shot.momentId);
    if (!moment) throw new Error(`GAMEPLAY_REFERENCE_MOMENT_NOT_FOUND:${shot.momentId}`);
    const concept = conceptById.get(moment.conceptId);
    if (!concept) throw new Error(`GAMEPLAY_REFERENCE_CONCEPT_NOT_FOUND:${moment.conceptId}`);
    referenceSets[shot.shotId] = await retrieveReferenceSet({
      concept,
      moment,
      shot,
      signal: context.signal,
    });
  }

  const promptPlans = compileGameplayPromptPlans({
    concepts: concepts.acceptedConcepts,
    moments: planning.moments,
    shots: visual.shots,
    feedbackMemory: feedback,
    gameplayReferencesByShot: referenceSets,
  });

  const planner = visual.shotPlannerMetadata;
  const usage = object(planner.usage);
  try {
    await repo.persistShotsAndPrompts({
      jobId: context.jobId,
      rootCreativeRunId,
      result: {
        shots: visual.shots,
        model: text(planner.model) ?? "persisted-shot-plan",
        repairModel: text(planner.repair_model) ?? "persisted-schema-repair",
        escalated: planner.escalated === true,
        rawResponseHashes: stringArray(planner.raw_response_hashes),
        usage: {
          inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : 0,
          outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : 0,
          totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : 0,
        },
      },
      promptPlans,
    });
  } catch (error) {
    throw persistenceError("GAMEPLAY_REFERENCE_PROMPT_PERSIST_FAILED", error);
  }

  return {
    ...outcome,
    state: {
      ...(outcome.state ?? context.state),
      prompt_plans: promptPlans,
      gameplay_reference_sets: referenceSets,
      gameplay_reference_integration_version: 1,
      gameplay_reference_count: Object.values(referenceSets).reduce(
        (total, set) => total + set.references.length,
        0,
      ),
    },
    stateReason: "s4_gameplay_references_retrieved_and_compiled",
    eventType: "discovery.gameplay_references_compiled",
    eventPayload: {
      shot_ids: visual.shots.map((shot) => shot.shotId),
      reference_counts: Object.fromEntries(
        Object.entries(referenceSets).map(([shotId, set]) => [shotId, set.references.length]),
      ),
      purposes: Object.fromEntries(
        Object.entries(referenceSets).map(([shotId, set]) => [
          shotId,
          set.references.map((item) => item.purpose),
        ]),
      ),
    },
  };
}

async function handleReferenceImageAdmission(
  context: WorkflowTickContext,
): Promise<WorkflowTickOutcome> {
  const rootCreativeRunId = text(context.state.creative_run_id);
  if (!rootCreativeRunId) {
    throw new Error("GAMEPLAY_REFERENCE_ROOT_RUN_MISSING");
  }
  const repo = repository(context);
  let visual;
  let referenceStage;
  try {
    [visual, referenceStage] = await Promise.all([
      repo.getVisualStage({ rootCreativeRunId }),
      repo.getReferenceImageStage({ rootCreativeRunId }),
    ]);
  } catch (error) {
    throw persistenceError("GAMEPLAY_REFERENCE_IMAGE_ADMISSION_CONTEXT_FAILED", error);
  }

  if (!visual.shots.length || visual.promptPlans.length !== visual.shots.length) {
    throw new Error("GAMEPLAY_REFERENCE_IMAGE_PLAN_MISSING");
  }

  const existingShotIds = new Set(referenceStage.items.map((item) => item.shotId));
  const admissions: Array<{
    shotId: string;
    generationId: string;
    factoryJobId: string;
    referenceCount: number;
  }> = [];

  for (const shot of visual.shots) {
    if (existingShotIds.has(shot.shotId)) continue;
    const promptPlan = visual.promptPlans.find((plan) => plan.shotId === shot.shotId);
    if (!promptPlan?.imagePrompt) throw new Error(`GAMEPLAY_REFERENCE_IMAGE_PROMPT_MISSING:${shot.shotId}`);
    const referenceSet = referenceSetFromPromptMetadata(promptPlan.metadata);
    if (!referenceSet || referenceSet.references.length < 4) {
      throw new Error(`GAMEPLAY_REFERENCE_IMAGE_SET_MISSING:${shot.shotId}`);
    }
    const requestId = stableUuid(
      `stage4-reference:${context.jobId}:${shot.shotId}:r${visual.referenceRevisionNumber}`,
    );
    const data = await callStage4ReferenceService<{
      generationId: string;
      factoryJobId: string;
      duplicate: boolean;
      referenceCount: number;
    }>(
      {
        action: "admit_reference_image",
        rootJobId: context.jobId,
        rootCreativeRunId,
        requestId,
        conceptId: promptPlan.conceptId,
        momentId: promptPlan.momentId,
        shotId: shot.shotId,
        prompt: promptPlan.imagePrompt,
        modelId: shot.generationPlan.imageModel ?? "nano-banana-2",
        referenceSet,
      },
      context.signal,
    );
    admissions.push({
      shotId: shot.shotId,
      generationId: data.generationId,
      factoryJobId: data.factoryJobId,
      referenceCount: data.referenceCount,
    });
  }

  return {
    status: "waiting",
    currentStage: "reference_image_waiting",
    progress: 80,
    nextActionAt: new Date(Date.now() + REFERENCE_POLL_MS).toISOString(),
    enqueueReason: "reference_image_reconcile",
    state: {
      ...context.state,
      reference_image_admissions: admissions,
      reference_revision_number: visual.referenceRevisionNumber,
      reference_approval_required: true,
      video_generation_locked: true,
      gameplay_reference_gate_required: true,
    },
    stateReason: "s4_reference_images_admitted_with_gameplay_references",
    eventType: "discovery.reference_images_admitted",
    eventPayload: {
      admitted_count: admissions.length,
      expected_count: visual.shots.length,
      reference_counts: Object.fromEntries(
        admissions.map((item) => [item.shotId, item.referenceCount]),
      ),
      reference_revision_number: visual.referenceRevisionNumber,
      video_generation_locked: true,
    },
  };
}

export const gameDiscoveryBatchStage4ReferenceIntegratedV1: WorkflowTickHandler = async (context) => {
  if (context.currentStage === "reference_image_generation_pending") {
    return handleReferenceImageAdmission(context);
  }

  const outcome = await gameDiscoveryBatchStage4DurableV1(context);
  return ensurePromptReferenceSets(context, outcome);
};
