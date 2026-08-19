import { createHash } from "node:crypto";
import { DurableWorkflowError } from "../../lib/orchestrator/retry";
import type { DurableVideoGeneration } from "../../lib/orchestrator/generation-videos";
import {
  KieMarketTaskError,
  type KieMarketTaskAdapter,
  type KieMarketTaskState,
} from "../../lib/models/kie/market-task";
import type { KieVeoTaskAdapter } from "../../lib/models/kie/veo-task";
import type { WorkflowTickContext, WorkflowTickHandler, WorkflowTickOutcome } from "./types";

const NORMAL_POLL_MS = 5_000;
const AMBIGUOUS_SUBMIT_RECHECK_MS = 60_000;
const KLING_SINGLE_SHOT_PROMPT_MAX_CHARS = 2_000;
const KLING_MULTI_SHOT_PROMPT_MAX_CHARS = 500;
const KLING_PROMPT_OMISSION_MARKER = "\n\n[...provider-safe compacted context...]\n\n";

export interface VideoProviderRequest {
  adapter: "market" | "veo";
  model: string;
  input: Record<string, unknown>;
}

type VideoTaskAdapter = Pick<KieMarketTaskAdapter, "submit" | "getTask"> | Pick<KieVeoTaskAdapter, "submit" | "getTask">;

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

function booleanSetting(settings: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = settings[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function assetUrls(
  generation: DurableVideoGeneration,
  role?: string,
): string[] {
  return generation.referenceAssets.flatMap((asset) => {
    if (role && asset.role !== role) return [];
    return typeof asset.url === "string" && asset.url ? [asset.url] : [];
  });
}

function visualUrls(generation: DurableVideoGeneration): string[] {
  return generation.referenceAssets.flatMap((asset) =>
    typeof asset.url === "string" && asset.url ? [asset.url] : [],
  );
}

function modeAssets(generation: DurableVideoGeneration): string[] {
  const start = assetUrls(generation, "start_frame");
  const end = assetUrls(generation, "end_frame");
  const refs = assetUrls(generation, "reference");
  if (generation.mode === "start-end-frames") return [...start.slice(0, 1), ...end.slice(0, 1)];
  if (generation.mode === "image-to-video") return start.slice(0, 1);
  if (generation.mode === "reference-to-video") return refs.length ? refs : visualUrls(generation);
  return [];
}

export function compactKlingProviderPrompt(prompt: string, maxChars = KLING_SINGLE_SHOT_PROMPT_MAX_CHARS): string {
  const normalized = prompt.replace(/\r\n?/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= KLING_PROMPT_OMISSION_MARKER.length + 2) return normalized.slice(0, maxChars);

  // Stage 4 places the concrete gameplay beat near the beginning and the non-negotiable
  // player-attached camera / continuous-capture contract near the end. Keep both rather
  // than blindly chopping off the tail. This is a defensive provider budget, not a model
  // schema limit; the full typed prompt remains persisted in discovery lineage.
  const available = maxChars - KLING_PROMPT_OMISSION_MARKER.length;
  const tailChars = Math.min(850, Math.max(1, Math.floor(available * 0.45)));
  const headChars = available - tailChars;
  return `${normalized.slice(0, headChars).trimEnd()}${KLING_PROMPT_OMISSION_MARKER}${normalized.slice(-tailChars).trimStart()}`;
}

function klingQuality(generation: DurableVideoGeneration): string {
  const effective = stringSetting(generation.settings, "effectiveQuality", "effective_quality");
  if (effective && ["std", "pro", "4K"].includes(effective)) return effective;
  const quality = stringSetting(generation.settings, "quality", "requested_quality");
  return quality === "low" ? "std" : quality === "high" ? "4K" : "pro";
}

function veoModel(generation: DurableVideoGeneration): string {
  const effective = stringSetting(generation.settings, "effectiveQuality", "effective_quality");
  if (effective === "lite") return "veo3_lite";
  if (effective === "quality") return "veo3_quality";
  if (effective === "fast") return "veo3_fast";
  const quality = stringSetting(generation.settings, "quality", "requested_quality");
  return quality === "low" ? "veo3_lite" : quality === "high" ? "veo3_quality" : "veo3_fast";
}

export function buildVideoProviderRequest(generation: DurableVideoGeneration): VideoProviderRequest {
  const settings = generation.settings ?? {};
  const aspectRatio = stringSetting(settings, "aspectRatio", "aspect_ratio") ?? "16:9";
  const resolution = stringSetting(settings, "resolution");
  const duration = Math.max(1, Math.trunc(numericSetting(settings, "durationSec", "duration_sec", "duration") ?? 5));
  const sound = booleanSetting(settings, "sound", "audio", "generate_audio") ?? false;
  const multiShot = booleanSetting(settings, "multiShot", "multi_shot", "multi_shots") ?? false;
  const urls = modeAssets(generation);
  const startFrame = assetUrls(generation, "start_frame")[0];
  const endFrame = assetUrls(generation, "end_frame")[0];

  if (generation.modelId === "kling-3") {
    if (generation.mode === "reference-to-video") {
      throw new DurableWorkflowError({
        code: "VIDEO_MODE_NOT_SUPPORTED",
        message: "Kling 3 generic reference-to-video requires element metadata that is not present in this request",
        retryable: false,
      });
    }
    const providerPrompt = compactKlingProviderPrompt(
      generation.prompt,
      multiShot ? KLING_MULTI_SHOT_PROMPT_MAX_CHARS : KLING_SINGLE_SHOT_PROMPT_MAX_CHARS,
    );
    const input: Record<string, unknown> = {
      ...(multiShot
        ? { multi_shots: true, multi_prompt: [{ prompt: providerPrompt, duration }] }
        : { prompt: providerPrompt, multi_shots: false }),
      ...(urls.length ? { image_urls: urls.slice(0, 2) } : {}),
      sound,
      duration: String(duration),
      // KIE documents aspect-ratio auto-adaptation whenever first/last image_urls are supplied.
      // Let the already-approved 16:9 gameplay still define Kling I2V geometry; text-to-video
      // continues to require an explicit requested ratio.
      ...(urls.length ? {} : { aspect_ratio: aspectRatio }),
      mode: klingQuality(generation),
    };
    return { adapter: "market", model: "kling-3.0/video", input };
  }

  if (generation.modelId === "seedance-2-5") {
    return {
      adapter: "market",
      model: "bytedance/seedance-2-5",
      input: {
        prompt: generation.prompt,
        ...(urls.length ? { reference_image_urls: urls } : {}),
        return_last_frame: false,
        generate_audio: sound,
        resolution: resolution ?? "720p",
        aspect_ratio: aspectRatio,
        duration,
      },
    };
  }

  if (generation.modelId === "wan-2-7") {
    const common = {
      prompt: generation.prompt,
      resolution: resolution ?? "1080p",
      duration,
      prompt_extend: true,
      watermark: false,
      seed: 0,
    };
    if (generation.mode === "reference-to-video") {
      return {
        adapter: "market",
        model: "wan/2-7-r2v",
        input: {
          ...common,
          reference_image: urls,
          aspect_ratio: aspectRatio,
        },
      };
    }
    if (generation.mode === "image-to-video" || generation.mode === "start-end-frames") {
      if (!startFrame) {
        throw new DurableWorkflowError({
          code: "VIDEO_INPUT_MISSING",
          message: "Wan 2.7 image-to-video requires a start frame",
          retryable: false,
        });
      }
      return {
        adapter: "market",
        model: "wan/2-7-image-to-video",
        input: {
          ...common,
          first_frame_url: startFrame,
          ...(endFrame ? { last_frame_url: endFrame } : {}),
        },
      };
    }
    return {
      adapter: "market",
      model: "wan/2-7-text-to-video",
      input: {
        ...common,
        ratio: aspectRatio,
      },
    };
  }

  if (generation.modelId === "veo-3-1") {
    const generationType =
      generation.mode === "reference-to-video"
        ? "REFERENCE_2_VIDEO"
        : generation.mode === "image-to-video" || generation.mode === "start-end-frames"
          ? "FIRST_AND_LAST_FRAMES_2_VIDEO"
          : "TEXT_2_VIDEO";
    return {
      adapter: "veo",
      model: veoModel(generation),
      input: {
        prompt: generation.prompt,
        ...(urls.length ? { imageUrls: urls.slice(0, generationType === "REFERENCE_2_VIDEO" ? 4 : 2) } : {}),
        aspect_ratio: aspectRatio,
        enableFallback: false,
        enableTranslation: true,
        generationType,
      },
    };
  }

  throw new DurableWorkflowError({
    code: "VIDEO_MODEL_NOT_SUPPORTED",
    message: `Durable video execution does not support model ${generation.modelId}`,
    retryable: false,
  });
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function outputState(value: unknown): Array<{ url: string; kind: "video" }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    return typeof record.url === "string" && record.url
      ? [{ url: record.url, kind: "video" as const }]
      : [];
  });
}

function nextAt(delayMs: number): string {
  return new Date(Date.now() + delayMs).toISOString();
}

function waitingOutcome(input: {
  context: WorkflowTickContext;
  generationId: string;
  variantIndex: number;
  outputs: Array<{ url: string; kind: "video" }>;
  providerTaskId: string;
  externalTaskId?: string | null;
  ambiguousSubmit?: boolean;
  delayMs: number;
  providerState?: string;
}): WorkflowTickOutcome {
  const nextActionAt = nextAt(input.delayMs);
  return {
    status: "waiting",
    state: {
      ...input.context.state,
      generation_id: input.generationId,
      variant_index: input.variantIndex,
      outputs: input.outputs,
      provider_task_id: input.providerTaskId,
      external_task_id: input.externalTaskId ?? null,
      ambiguous_submit: input.ambiguousSubmit ?? false,
      ...(input.providerState ? { provider_state: input.providerState } : {}),
    },
    currentStage: "provider_video",
    progress: 35,
    nextActionAt,
    stateReason: input.ambiguousSubmit ? "provider_submit_ambiguous" : "provider_video_waiting",
    eventType: "provider.waiting",
    eventPayload: {
      generation_id: input.generationId,
      provider_task_id: input.providerTaskId,
      external_task_id: input.externalTaskId ?? null,
      provider_state: input.providerState ?? null,
      ambiguous_submit: input.ambiguousSubmit ?? false,
    },
    enqueueReason: "provider_poll",
  };
}

function requireRuntime(context: WorkflowTickContext) {
  const workerId = context.workerId;
  const leaseToken = context.leaseToken;
  const services = context.services;
  if (!workerId || !leaseToken || !services) {
    throw new DurableWorkflowError({
      code: "WORKER_RUNTIME_MISSING",
      message: "Durable video workflow requires worker runtime services",
      retryable: true,
    });
  }
  return { workerId, leaseToken, services };
}

function providerErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof KieMarketTaskError) {
    return {
      code: "KIE_SUBMIT_REJECTED",
      message: error.message,
      retryable: error.retryable,
      ambiguous_submit: error.ambiguousSubmit,
      provider_code: error.providerCode,
      provider_message: error.providerMessage,
    };
  }
  return {
    code: "KIE_SUBMIT_REJECTED",
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
      retryAfterMs: NORMAL_POLL_MS,
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
    currentStage: "provider_video",
    error: {
      code: input.code,
      message: input.message,
      retryable: false,
      ...(input.details ? { details: input.details } : {}),
    },
    stateReason: `generation_video_failed:${input.code}`,
    eventType: "job.failed",
    eventPayload: {
      generation_id: input.generationId,
      provider_task_id: input.providerTaskId ?? null,
      error_code: input.code,
    },
  };
}

export const generationVideoV1: WorkflowTickHandler = async (context) => {
  if (context.signal.aborted) throw new Error("generation_video tick aborted");

  const { workerId, leaseToken, services } = requireRuntime(context);
  const generation = await services.generationVideos.get(context.jobId);
  if (!generation) {
    throw new DurableWorkflowError({
      code: "VIDEO_GENERATION_NOT_FOUND",
      message: `No video generation is linked to job ${context.jobId}`,
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
      code: "VIDEO_GENERATION_ALREADY_FAILED",
      message: "Video generation is already failed",
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
  const providerRequest = buildVideoProviderRequest(generation);
  const stableRequestPayload = {
    adapter: providerRequest.adapter,
    model: providerRequest.model,
    input: providerRequest.input,
  };
  const requestPayloadHash = hashPayload(stableRequestPayload);

  const adapter: VideoTaskAdapter | null =
    providerRequest.adapter === "veo" ? services.kieVeoTask : services.kieMarketTask;
  if (!adapter) {
    throw new DurableWorkflowError({
      code: "KIE_API_NOT_CONFIGURED",
      message: "KIE API key is not configured for durable video execution",
      retryable: false,
    });
  }

  let providerTaskId =
    typeof context.state.provider_task_id === "string" ? context.state.provider_task_id : null;
  let externalTaskId =
    typeof context.state.external_task_id === "string" ? context.state.external_task_id : null;

  if (!providerTaskId) {
    const prepared = await services.providerTasks.prepare({
      jobId: context.jobId,
      workerId,
      leaseToken,
      stage: "provider_video",
      stageAttempt: variantIndex + 1,
      provider: "kie",
      model: providerRequest.model,
      submissionKey: `generation:${generation.id}:video:v1:${variantIndex}`,
      variantIndex,
      requestPayload: stableRequestPayload,
      requestPayloadHash,
    });

    providerTaskId = prepared.providerTaskId;
    externalTaskId = prepared.externalTaskId;
    await services.generationVideos.markProcessing(context.jobId, providerTaskId);

    if (prepared.shouldSubmit) {
      const callbackUrl = `${services.appUrl.replace(/\/+$/, "")}/api/providers/kie/callback/${providerTaskId}/${prepared.callbackToken}`;
      let submitted;
      try {
        submitted = await adapter.submit({
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
        await services.generationVideos.fail({
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
        // The accepted external id is kept in durable job state and the next tick can
        // reconcile it without ever issuing a second paid submit.
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
    detail = await adapter.getTask({ taskId: externalTaskId, signal: context.signal });
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
    await services.generationVideos.markProcessing(context.jobId, providerTaskId);
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
    const message = detail.failMessage || "KIE video generation failed";
    await services.generationVideos.fail({
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
    await services.generationVideos.fail({
      jobId: context.jobId,
      providerTaskId,
      errorCode: "VIDEO_PROVIDER_RESULT_MISSING",
      errorMessage: "KIE reported success without a video result URL",
    });
    return terminalFailure({
      context,
      generationId: generation.id,
      providerTaskId,
      code: "VIDEO_PROVIDER_RESULT_MISSING",
      message: "KIE reported success without a video result URL",
    });
  }

  const nextOutputs = [...outputs, { url, kind: "video" as const }];
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
      currentStage: "provider_video",
      progress: Math.min(90, Math.round(((variantIndex + 1) / requestedOutputs) * 90)),
      stateReason: "video_variant_completed",
      eventType: "stage.succeeded",
      eventPayload: {
        generation_id: generation.id,
        variant_index: variantIndex,
        provider_task_id: providerTaskId,
      },
      enqueueReason: "next_variant",
    };
  }

  await services.generationVideos.complete({
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
    stateReason: "generation_video_completed",
    eventType: "job.completed",
    eventPayload: {
      generation_id: generation.id,
      output_count: nextOutputs.length,
      provider_task_id: providerTaskId,
    },
  };
};
