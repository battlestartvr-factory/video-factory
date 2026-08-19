import { describe, expect, it, vi } from "vitest";
import type { GenerationImageRepository } from "@/lib/orchestrator/generation-images";
import type {
  DurableVideoGeneration,
  GenerationVideoRepository,
} from "@/lib/orchestrator/generation-videos";
import type { ProviderTaskRepository } from "@/lib/orchestrator/provider-tasks";
import { KieMarketTaskError, type KieMarketTaskAdapter } from "@/lib/models/kie/market-task";
import type { KieVeoTaskAdapter } from "@/lib/models/kie/veo-task";
import {
  buildVideoProviderRequest,
  compactKlingProviderPrompt,
  generationVideoV1,
} from "@/worker/workflows/generation-video-v1";
import type { WorkflowServices } from "@/worker/workflows/types";

function generation(
  overrides: Partial<DurableVideoGeneration> = {},
): DurableVideoGeneration {
  return {
    id: "video-gen-1",
    prompt: "A cinematic robot walks through a neon factory",
    modelId: "kling-3",
    mode: "text-to-video",
    settings: {
      aspectRatio: "16:9",
      durationSec: 5,
      effectiveQuality: "std",
      sound: false,
      numOutputs: 1,
    },
    referenceAssets: [],
    status: "processing",
    ...overrides,
  };
}

function createServices(input: {
  generationValue?: DurableVideoGeneration;
  prepare?: ReturnType<typeof vi.fn>;
  marketSubmit?: ReturnType<typeof vi.fn>;
  marketGetTask?: ReturnType<typeof vi.fn>;
  veoSubmit?: ReturnType<typeof vi.fn>;
  veoGetTask?: ReturnType<typeof vi.fn>;
}) {
  const prepare =
    input.prepare ??
    vi.fn().mockResolvedValue({
      providerTaskId: "pt-video-1",
      stageId: "stage-video-1",
      status: "submitting",
      externalTaskId: null,
      callbackToken: "callback-video-1",
      submissionAttempts: 1,
      shouldSubmit: true,
    });
  const recordSubmit = vi.fn().mockResolvedValue(undefined);
  const recordSubmitFailure = vi.fn().mockResolvedValue(undefined);
  const recordStatus = vi.fn().mockResolvedValue({ status: "succeeded", error: null });
  const markProcessing = vi.fn().mockResolvedValue(undefined);
  const complete = vi.fn().mockResolvedValue(undefined);
  const fail = vi.fn().mockResolvedValue(undefined);

  const marketSubmit =
    input.marketSubmit ??
    vi.fn().mockResolvedValue({
      taskId: "kie-video-1",
      payload: { code: 200, data: { taskId: "kie-video-1" } },
    });
  const marketGetTask =
    input.marketGetTask ??
    vi.fn().mockResolvedValue({
      taskId: "kie-video-1",
      model: "kling-3.0/video",
      state: "success",
      resultUrls: ["https://example.test/video.mp4"],
      failCode: null,
      failMessage: null,
      progress: 100,
      creditsConsumed: 12,
      payload: { code: 200, data: { state: "success" } },
    });
  const veoSubmit =
    input.veoSubmit ??
    vi.fn().mockResolvedValue({
      taskId: "kie-veo-1",
      payload: { code: 200, data: { taskId: "kie-veo-1" } },
    });
  const veoGetTask =
    input.veoGetTask ??
    vi.fn().mockResolvedValue({
      taskId: "kie-veo-1",
      model: null,
      state: "success",
      resultUrls: ["https://example.test/veo.mp4"],
      failCode: null,
      failMessage: null,
      progress: 100,
      creditsConsumed: null,
      payload: { code: 200, data: { successFlag: 1 } },
    });

  const providerTasks = {
    prepare,
    recordSubmit,
    recordSubmitFailure,
    recordStatus,
  } as unknown as ProviderTaskRepository;
  const generationVideos = {
    get: vi.fn().mockResolvedValue(input.generationValue ?? generation()),
    markProcessing,
    complete,
    fail,
  } as unknown as GenerationVideoRepository;
  const market = {
    submit: marketSubmit,
    getTask: marketGetTask,
  } as unknown as KieMarketTaskAdapter;
  const veo = {
    submit: veoSubmit,
    getTask: veoGetTask,
  } as unknown as KieVeoTaskAdapter;

  return {
    value: {
      providerTasks,
      generationImages: {} as GenerationImageRepository,
      generationVideos,
      kieMarketTask: market,
      kieVeoTask: veo,
      appUrl: "https://factory.example.test",
    } satisfies WorkflowServices,
    mocks: {
      prepare,
      recordSubmit,
      recordSubmitFailure,
      recordStatus,
      markProcessing,
      complete,
      fail,
      marketSubmit,
      marketGetTask,
      veoSubmit,
      veoGetTask,
    },
  };
}

function context(services: WorkflowServices, state: Record<string, unknown> = {}) {
  return {
    jobId: "video-job-1",
    workflowKind: "generation_video",
    workflowVersion: 1,
    currentStage: "provider_video",
    state,
    retryCount: 0,
    signal: new AbortController().signal,
    workerId: "worker-video-1",
    leaseToken: "lease-video-1",
    services,
  };
}

describe("generation_video@1 provider mapping", () => {
  it("maps Kling 3 text-to-video to the unified KIE task contract", () => {
    expect(buildVideoProviderRequest(generation())).toEqual({
      adapter: "market",
      model: "kling-3.0/video",
      input: {
        prompt: "A cinematic robot walks through a neon factory",
        multi_shots: false,
        sound: false,
        duration: "5",
        aspect_ratio: "16:9",
        mode: "std",
      },
    });
  });

  it("lets a Kling image-to-video start frame define the aspect ratio", () => {
    const request = buildVideoProviderRequest(
      generation({
        mode: "image-to-video",
        settings: {
          aspectRatio: "16:9",
          durationSec: 5,
          effectiveQuality: "pro",
          sound: false,
          numOutputs: 1,
        },
        referenceAssets: [{ url: "https://example.test/widescreen.png", role: "start_frame" }],
      }),
    );

    expect(request).toMatchObject({
      adapter: "market",
      model: "kling-3.0/video",
      input: {
        image_urls: ["https://example.test/widescreen.png"],
        duration: "5",
        mode: "pro",
        multi_shots: false,
      },
    });
    expect(request.input.aspect_ratio).toBeUndefined();
  });

  it("bounds the Kling provider prompt while preserving the gameplay beat and hard camera tail", () => {
    const hardCamera =
      "camera remains physically attached to the playable character for the entire clip";
    const prompt = `START ACTIVE GAMEPLAY ${"foreground mechanics ".repeat(120)} ${hardCamera}. END CONTINUOUS CAPTURE`;
    const compacted = compactKlingProviderPrompt(prompt);

    expect(compacted.length).toBeLessThanOrEqual(2_000);
    expect(compacted).toContain("START ACTIVE GAMEPLAY");
    expect(compacted).toContain(hardCamera);
    expect(compacted).toContain("END CONTINUOUS CAPTURE");
    expect(compacted).toContain("provider-safe compacted context");
  });

  it("maps Seedance first and last frames into reference image URLs", () => {
    expect(
      buildVideoProviderRequest(
        generation({
          modelId: "seedance-2-5",
          mode: "start-end-frames",
          settings: {
            aspectRatio: "9:16",
            resolution: "720p",
            durationSec: 10,
            sound: true,
            numOutputs: 1,
          },
          referenceAssets: [
            { url: "https://example.test/start.png", role: "start_frame" },
            { url: "https://example.test/end.png", role: "end_frame" },
          ],
        }),
      ),
    ).toEqual({
      adapter: "market",
      model: "bytedance/seedance-2-5",
      input: {
        prompt: "A cinematic robot walks through a neon factory",
        reference_image_urls: [
          "https://example.test/start.png",
          "https://example.test/end.png",
        ],
        return_last_frame: false,
        generate_audio: true,
        resolution: "720p",
        aspect_ratio: "9:16",
        duration: 10,
      },
    });
  });

  it("maps Wan 2.7 start/end frames to the image-to-video model", () => {
    const request = buildVideoProviderRequest(
      generation({
        modelId: "wan-2-7",
        mode: "start-end-frames",
        referenceAssets: [
          { url: "https://example.test/start.png", role: "start_frame" },
          { url: "https://example.test/end.png", role: "end_frame" },
        ],
      }),
    );
    expect(request.adapter).toBe("market");
    expect(request.model).toBe("wan/2-7-image-to-video");
    expect(request.input.first_frame_url).toBe("https://example.test/start.png");
    expect(request.input.last_frame_url).toBe("https://example.test/end.png");
  });

  it("maps Wan 2.7 references to the reference-to-video model", () => {
    const request = buildVideoProviderRequest(
      generation({
        modelId: "wan-2-7",
        mode: "reference-to-video",
        referenceAssets: [
          { url: "https://example.test/ref-a.png", role: "reference" },
          { url: "https://example.test/ref-b.png", role: "reference" },
        ],
      }),
    );
    expect(request.model).toBe("wan/2-7-r2v");
    expect(request.input.reference_image).toEqual([
      "https://example.test/ref-a.png",
      "https://example.test/ref-b.png",
    ]);
  });

  it("maps Veo reference generation to its dedicated adapter", () => {
    expect(
      buildVideoProviderRequest(
        generation({
          modelId: "veo-3-1",
          mode: "reference-to-video",
          settings: { aspectRatio: "16:9", effectiveQuality: "fast", numOutputs: 1 },
          referenceAssets: [{ url: "https://example.test/ref.png", role: "reference" }],
        }),
      ),
    ).toEqual({
      adapter: "veo",
      model: "veo3_fast",
      input: {
        prompt: "A cinematic robot walks through a neon factory",
        imageUrls: ["https://example.test/ref.png"],
        aspect_ratio: "16:9",
        enableFallback: false,
        enableTranslation: true,
        generationType: "REFERENCE_2_VIDEO",
      },
    });
  });
});

describe("generation_video@1 lifecycle", () => {
  it("never submits again when the durable paid-submit permit was already consumed", async () => {
    const marketSubmit = vi.fn();
    const setup = createServices({
      marketSubmit,
      prepare: vi.fn().mockResolvedValue({
        providerTaskId: "pt-existing",
        stageId: "stage-video-1",
        status: "submitting",
        externalTaskId: null,
        callbackToken: "token-existing",
        submissionAttempts: 1,
        shouldSubmit: false,
      }),
    });

    const outcome = await generationVideoV1(context(setup.value));
    expect(outcome.status).toBe("waiting");
    expect(outcome.state?.ambiguous_submit).toBe(true);
    expect(marketSubmit).not.toHaveBeenCalled();
  });

  it("persists KIE application rejection details without retrying the paid submit", async () => {
    const marketSubmit = vi.fn().mockRejectedValue(
      new KieMarketTaskError(
        "KIE createTask rejected (code=422): invalid image input",
        false,
        false,
        422,
        "invalid image input",
      ),
    );
    const setup = createServices({ marketSubmit });

    const outcome = await generationVideoV1(context(setup.value));
    expect(outcome.status).toBe("failed");
    expect(setup.mocks.recordSubmitFailure).toHaveBeenCalledWith({
      providerTaskId: "pt-video-1",
      error: expect.objectContaining({
        provider_code: 422,
        provider_message: "invalid image input",
        ambiguous_submit: false,
      }),
    });
    expect(marketSubmit).toHaveBeenCalledOnce();
  });

  it("reconciles a persisted Market task to video completion without another submit", async () => {
    const marketSubmit = vi.fn();
    const setup = createServices({ marketSubmit });
    const outcome = await generationVideoV1(
      context(setup.value, {
        generation_id: "video-gen-1",
        variant_index: 0,
        outputs: [],
        provider_task_id: "pt-video-1",
        external_task_id: "kie-video-1",
      }),
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.result?.outputs).toEqual([
      { url: "https://example.test/video.mp4", kind: "video" },
    ]);
    expect(marketSubmit).not.toHaveBeenCalled();
    expect(setup.mocks.recordStatus).toHaveBeenCalledOnce();
    expect(setup.mocks.complete).toHaveBeenCalledOnce();
  });

  it("uses the Veo adapter for Veo tasks and preserves the same submit fencing", async () => {
    const marketSubmit = vi.fn();
    const setup = createServices({
      generationValue: generation({
        modelId: "veo-3-1",
        mode: "text-to-video",
        settings: { aspectRatio: "16:9", effectiveQuality: "fast", numOutputs: 1 },
      }),
      marketSubmit,
    });

    const outcome = await generationVideoV1(context(setup.value));
    expect(outcome.status).toBe("waiting");
    expect(setup.mocks.veoSubmit).toHaveBeenCalledOnce();
    expect(marketSubmit).not.toHaveBeenCalled();
    expect(setup.mocks.recordSubmit).toHaveBeenCalledOnce();
  });
});
