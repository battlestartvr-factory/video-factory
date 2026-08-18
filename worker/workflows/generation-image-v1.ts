import { createHash } from "node:crypto";
import { DurableWorkflowError } from "../../lib/orchestrator/retry";
import {
  KieMarketTaskError,
  type KieMarketTaskState,
} from "../../lib/models/kie/market-task";
import type { DurableImageGeneration } from "../../lib/orchestrator/generation-images";
import type { WorkflowTickContext, WorkflowTickHandler, WorkflowTickOutcome } from "./types";

const NORMAL_POLL_MS = 4_000;
const AMBIGUOUS_SUBMIT_RECHECK_MS = 60_000;
const MAX_DOCUMENT_CONTEXT_CHARS = 24_000;

export interface ImageProviderRequest {
  model: string;
  input: Record<string, unknown>;
}

function stringSetting(settings: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = settings[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numericSetting(settings: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = settings[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function usableReferenceUrls(generation: DurableImageGeneration): string[] {
  return generation.referenceAssets
    .map((asset) => asset.url?.trim())
    .filter((url): url is string => Boolean(url));
}

function generationPrompt(generation: DurableImageGeneration): string {
  const documentContext = stringSetting(
    generation.settings,
    "documentContext",
    "document_context",
  );
  if (!documentContext) return generation.prompt;
  return `${generation.prompt}\n\nContext from attached brief documents. Use it as supporting creative direction; do not render it verbatim unless the prompt asks for text:\n${documentContext.slice(0, MAX_DOCUMENT_CONTEXT_CHARS)}`;
}

export function buildImageProviderRequest(
  generation: DurableImageGeneration,
): ImageProviderRequest {
  const aspectRatio = stringSetting(generation.settings, "aspectRatio", "aspect_ratio") ?? "auto";
  const referenceUrls = usableReferenceUrls(generation);
  const prompt = generationPrompt(generation);

  if (generation.modelId === "gpt-image-2") {
    if (referenceUrls.length > 4) {
      throw new DurableWorkflowError({
        code: "IMAGE_REFERENCE_LIMIT",
        message: "GPT Image 2 accepts at most 4 reference images",
        retryable: false,
      });
    }

    const resolution = stringSetting(
      generation.settings,
      "effectiveQuality",
      "effective_quality",
      "resolution",
    );

    if (referenceUrls.length > 0) {
      return {
        model: "gpt-image-2-image-to-image",
        input: {
          prompt,
          input_urls: referenceUrls,
          aspect_ratio: aspectRatio,
          ...(resolution ? { resolution } : {}),
        },
      };
    }

    return {
      model: "gpt-image-2-text-to-image",
      input: {
        prompt,
        aspect_ratio: aspectRatio,
        ...(resolution ? { resolution } : {}),
      },
    };
  }

  if (generation.modelId === "nano-banana-2" || generation.modelId === "nano-banana-pro") {
    const maxReferences = generation.modelId === "nano-banana-2" ? 8 : 4;
    if (referenceUrls.length > maxReferences) {
      throw new DurableWorkflowError({
        code: "IMAGE_REFERENCE_LIMIT",
        message: `${generation.modelId === "nano-banana-pro" ? "Nano Banana Pro" : "Nano Banana 2"} accepts at most ${maxReferences} reference images in this workflow`,
        retryable: false,
      });
    }
    const resolution =
      stringSetting(generation.settings, "effectiveQuality", "effective_quality", "resolution") ??
      "2K";
    return {
      model: generation.modelId,
      input: {
        prompt,
        image_input: referenceUrls,
        aspect_ratio: aspectRatio,
        resolution,
        output_format: "png",
      },
    };
  }

  throw new DurableWorkflowError({
    code: "IMAGE_MODEL_NOT_DURABLE",
    message: `Image model ${generation.modelId} is not enabled for generation_image@1`,
    retryable: false,
  });
}

function hashPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function outputState(value: unknown): Array<{ url: string; kind: "image"; mimeType?: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.url !== "string" || !row.url) return [];
    return [
      {
        url: row.url,
        kind: "image" as const,
        ...(typeof row.mimeType === "string" ? { mimeType: row.mimeType } : {}),
      },
    ];
  });
}

function nextAt(delayMs: number): string {
  return new Date(Date.now() + delayMs).toISOString();
}

function waitingOutcome(input: {
  context: WorkflowTickContext;
  generationId: string;
  variantIndex: number;
  outputs: Array<{ url: string; kind: "image"; mimeType?: string }>;
  providerTaskId: string;
  externalTaskId?: string | null;
  ambiguousSubmit?: boolean;
  delayMs: number;
  providerState?: string;
}): WorkflowTickOutcome {
  return {
    status: "waiting",
    state: {
      ...input.context.state,
      generation_id: input.generationId,
      variant_index: input.variantIndex,
      outputs: input.outputs,
      provider_task_id: input.providerTaskId,
      external_task_id: input.externalTaskId ?? null,
      ambiguous_submit: input.ambiguousSubmit === true,
    },
    currentStage: "provider_image",
    progress: Math.min(95, 10 + input.variantIndex * 10),
    nextActionAt: nextAt(input.delayMs),
    stateReason: input.ambiguousSubmit
      ? "provider_submit_ambiguous_waiting_callback"
      : `provider_${input.providerState ?? "waiting"}`,
    eventType: input.ambiguousSubmit ? "provider.submit_ambiguous" : "provider.waiting",
    eventPayload: {
      generation_id: input.generationId,
      variant_index: input.variantIndex,
      provider_task_id: input.providerTaskId,
      external_task_id: input.externalTaskId ?? null,
      provider_state: input.providerState ?? null,
    },
    enqueueReason: "provider_reconcile",
  };
}

function requireRuntime(context: WorkflowTickContext) {
  if (!context.workerId || !context.leaseToken || !context.services) {
    throw new DurableWorkflowError({
      code: "GENERATION_IMAGE_RUNTIME_MISSING",
      message: "generation_image@1 requires durable worker services and lease context",
      retryable: false,
    });
  }
  if (!context.services.kieMarketTask) {
    throw new DurableWorkflowError({
      code: "KIE_NOT_CONFIGURED",
      message: "KIE_API_KEY is required for generation_image@1",
      retryable: false,
    });
  }
  return {
    workerId: context.workerId,
    leaseToken: context.leaseToken,
    services: context.services,
    market: context.services.kieMarketTask,
  };
}

function providerErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof KieMarketTaskError) {
    return {
      code: error.ambiguousSubmit ? "KIE_SUBMIT_AMBIGUOUS" : "KIE_PROVIDER_ERROR",
      message: error.message,
      retryable: error.retryable,
      ambiguous_submit: error.ambiguousSubmit,
    };
  }
  return {
    code: "KIE_PROVIDER_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function pollError(error: unknown): DurableWorkflowError {
  if (error instanceof KieMarketTaskError) {
    return new DurableWorkflowError({
      code: "KIE_STATUS_RECONCILE_FAILED",
      message: error.message,
      retryable: error.retryable,
      retryAfterMs: error.retryable ? NORMAL_POLL_MS : undefined,
    });
  }
  return new DurableWorkflowError({
    code: "KIE_STATUS_RECONCILE_FAILED",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    retryAfterMs: NORMAL_POLL_MS,
  });
}

function terminalFailure(input: {
  context: WorkflowTickContext;
  generationId: string;
  providerTaskId?: string | null;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): WorkflowTickOutcome {
  return {
    status: "failed",
    state: input.context.state,
    currentStage: "provider_image",
    error: {
      code: input.code,
      message: input.message,
      retryable: false,
      ...(input.details ? { details: input.details } : {}),
    },
    stateReason: `generation_image_failed:${input.code}`,
    eventType: "job.failed",
    eventPayload: {
      generation_id: input.generationId,
      provider_task_id: input.providerTaskId ?? null,
      error_code: input.code,
    },
  };
}

export const generationImageV1: WorkflowTickHandler = async (context) => {
  if (context.signal.aborted) throw new Error("generation_image tick aborted");

  const { workerId, leaseToken, services, market } = requireRuntime(context);
  const generation = await services.generationImages.get(context.jobId);
  if (!generation) {
    throw new DurableWorkflowError({
      code: "IMAGE_GENERATION_NOT_FOUND",
      message: `No image generation is linked to job ${context.jobId}`,
      retryable: false,
    });
  }

  if (generation.status === "completed") {
    return {
      status: "completed",
      state: context.state,
      currentStage: "complete",
      progress: 100,
      result: { generation_id: generation.id, outputs: outputState(context.state.outputs) },
      stateReason: "generation_already_completed",
      eventType: "job.completed",
    };
  }
  if (generation.status === "cancelled") {
    return {
      status: "cancelled",
      state: context.state,
      currentStage: context.currentStage,
      stateReason: "generation_cancelled",
      eventType: "job.cancelled",
    };
  }
  if (generation.status === "failed") {
    return terminalFailure({
      context,
      generationId: generation.id,
      providerTaskId:
        typeof context.state.provider_task_id === "string" ? context.state.provider_task_id : null,
      code: "IMAGE_GENERATION_ALREADY_FAILED",
      message: "Image generation is already failed",
    });
  }

  const requestedOutputs = Math.max(
    1,
    Math.min(4, Math.trunc(numericSetting(generation.settings, "numOutputs", "outputs") ?? 1)),
  );
  const variantIndex =
    typeof context.state.variant_index === "number" && context.state.variant_index >= 0
      ? Math.trunc(context.state.variant_index)
      : 0;
  const outputs = outputState(context.state.outputs);
  const providerRequest = buildImageProviderRequest(generation);
  const stableRequestPayload = { model: providerRequest.model, input: providerRequest.input };
  const requestPayloadHash = hashPayload(stableRequestPayload);

  let providerTaskId =
    typeof context.state.provider_task_id === "string" ? context.state.provider_task_id : null;
  let externalTaskId =
    typeof context.state.external_task_id === "string" ? context.state.external_task_id : null;

  if (!providerTaskId) {
    const prepared = await services.providerTasks.prepare({
      jobId: context.jobId,
      workerId,
      leaseToken,
      stage: "provider_image",
      stageAttempt: variantIndex + 1,
      provider: "kie",
      model: providerRequest.model,
      submissionKey: `generation:${generation.id}:image:v1:${variantIndex}`,
      variantIndex,
      requestPayload: stableRequestPayload,
      requestPayloadHash,
    });

    providerTaskId = prepared.providerTaskId;
    externalTaskId = prepared.externalTaskId;
    await services.generationImages.markProcessing(context.jobId, providerTaskId);

    if (prepared.shouldSubmit) {
      const callbackUrl = `${services.appUrl.replace(/\/+$/, "")}/api/providers/kie/callback/${providerTaskId}/${prepared.callbackToken}`;
      let submitted;
      try {
        submitted = await market.submit({
          model: providerRequest.model,
          callbackUrl,
          providerInput: providerRequest.input,
          signal: context.signal,
        });
      } catch (error) {
        if (error instanceof KieMarketTaskError && error.ambiguousSubmit) {
          return waitingOutcome({
            context,
            generationId: generation.id,
            variantIndex,
            outputs,
            providerTaskId,
            externalTaskId: null,
            ambiguousSubmit: true,
            delayMs: AMBIGUOUS_SUBMIT_RECHECK_MS,
          });
        }

        const persistedError = providerErrorPayload(error);
        await services.providerTasks.recordSubmitFailure({ providerTaskId, error: persistedError });
        await services.generationImages.fail({
          jobId: context.jobId,
          providerTaskId,
          errorCode: "KIE_SUBMIT_REJECTED",
          errorMessage: persistedError.message as string,
        });
        return terminalFailure({
          context,
          generationId: generation.id,
          providerTaskId,
          code: "KIE_SUBMIT_REJECTED",
          message: persistedError.message as string,
          details: persistedError,
        });
      }

      externalTaskId = submitted.taskId;
      try {
        await services.providerTasks.recordSubmit({
          providerTaskId,
          externalTaskId,
          submitPayload: submitted.payload,
          nextCheckAt: nextAt(NORMAL_POLL_MS),
          responsePayloadHash: hashPayload(submitted.payload),
        });
      } catch {
        // We already know the accepted task id. Persist it in job state and reconcile on the
        // next tick; recordStatus can backfill provider_tasks.external_task_id safely.
      }

      return waitingOutcome({
        context,
        generationId: generation.id,
        variantIndex,
        outputs,
        providerTaskId,
        externalTaskId,
        delayMs: NORMAL_POLL_MS,
        providerState: "submitted",
      });
    }

    if (!externalTaskId) {
      return waitingOutcome({
        context,
        generationId: generation.id,
        variantIndex,
        outputs,
        providerTaskId,
        ambiguousSubmit: true,
        delayMs: AMBIGUOUS_SUBMIT_RECHECK_MS,
      });
    }
  }

  if (!externalTaskId) {
    return waitingOutcome({
      context,
      generationId: generation.id,
      variantIndex,
      outputs,
      providerTaskId,
      ambiguousSubmit: true,
      delayMs: AMBIGUOUS_SUBMIT_RECHECK_MS,
    });
  }

  let detail;
  try {
    detail = await market.getTask({ taskId: externalTaskId, signal: context.signal });
  } catch (error) {
    throw pollError(error);
  }

  await services.providerTasks.recordStatus({
    providerTaskId,
    externalTaskId,
    providerState: detail.state,
    statusPayload: detail.payload,
    nextCheckAt:
      detail.state === "success" || detail.state === "fail" ? null : nextAt(NORMAL_POLL_MS),
    creditsUsed: detail.creditsConsumed,
    responsePayloadHash: hashPayload(detail.payload),
  });

  if (["waiting", "queuing", "generating"].includes(detail.state as KieMarketTaskState)) {
    await services.generationImages.markProcessing(context.jobId, providerTaskId);
    return waitingOutcome({
      context,
      generationId: generation.id,
      variantIndex,
      outputs,
      providerTaskId,
      externalTaskId,
      delayMs: NORMAL_POLL_MS,
      providerState: detail.state,
    });
  }

  if (detail.state === "fail") {
    const code = detail.failCode || "KIE_GENERATION_FAILED";
    const message = detail.failMessage || "KIE image generation failed";
    await services.generationImages.fail({
      jobId: context.jobId,
      providerTaskId,
      errorCode: code,
      errorMessage: message,
    });
    return terminalFailure({
      context,
      generationId: generation.id,
      providerTaskId,
      code,
      message,
      details: { provider_state: detail.state },
    });
  }

  const url = detail.resultUrls[0];
  if (!url) {
    await services.generationImages.fail({
      jobId: context.jobId,
      providerTaskId,
      errorCode: "IMAGE_PROVIDER_RESULT_MISSING",
      errorMessage: "KIE reported success without a result URL",
    });
    return terminalFailure({
      context,
      generationId: generation.id,
      providerTaskId,
      code: "IMAGE_PROVIDER_RESULT_MISSING",
      message: "KIE reported success without a result URL",
    });
  }

  const nextOutputs = [...outputs, { url, kind: "image" as const }];
  if (variantIndex + 1 < requestedOutputs) {
    return {
      status: "queued",
      state: {
        ...context.state,
        generation_id: generation.id,
        variant_index: variantIndex + 1,
        outputs: nextOutputs,
        provider_task_id: null,
        external_task_id: null,
        ambiguous_submit: false,
      },
      currentStage: "provider_image",
      progress: Math.min(90, Math.round(((variantIndex + 1) / requestedOutputs) * 90)),
      stateReason: "image_variant_completed",
      eventType: "stage.succeeded",
      eventPayload: {
        generation_id: generation.id,
        variant_index: variantIndex,
        provider_task_id: providerTaskId,
      },
      enqueueReason: "next_variant",
    };
  }

  await services.generationImages.complete({
    jobId: context.jobId,
    providerTaskId,
    outputs: nextOutputs,
  });

  return {
    status: "completed",
    state: {
      ...context.state,
      generation_id: generation.id,
      variant_index: variantIndex,
      outputs: nextOutputs,
      provider_task_id: providerTaskId,
      external_task_id: externalTaskId,
      ambiguous_submit: false,
    },
    currentStage: "complete",
    progress: 100,
    result: {
      generation_id: generation.id,
      outputs: nextOutputs,
    },
    stateReason: "generation_image_completed",
    eventType: "job.completed",
    eventPayload: {
      generation_id: generation.id,
      output_count: nextOutputs.length,
      provider_task_id: providerTaskId,
    },
  };
};
