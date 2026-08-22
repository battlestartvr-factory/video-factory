import { describe, expect, it, vi } from "vitest";
import type {
  DurableImageGeneration,
  GenerationImageRepository,
} from "@/lib/orchestrator/generation-images";
import type { GenerationVideoRepository } from "@/lib/orchestrator/generation-videos";
import type { ProviderTaskRepository } from "@/lib/orchestrator/provider-tasks";
import {
  KieMarketTaskError,
  type KieMarketTaskAdapter,
} from "@/lib/models/kie/market-task";
import {
  buildImageProviderRequest,
  generationImageV1,
} from "@/worker/workflows/generation-image-v1";
import type { WorkflowServices } from "@/worker/workflows/types";
import { listRegisteredWorkflows } from "@/worker/workflows/registry";

function generation(
  overrides: Partial<DurableImageGeneration> = {},
): DurableImageGeneration {
  return {
    id: "gen-1",
    prompt: "A cinematic factory at night",
    modelId: "gpt-image-2",
    mode: "text-to-image",
    settings: { aspectRatio: "16:9", numOutputs: 1 },
    referenceAssets: [],
    status: "processing",
    ...overrides,
  };
}

function services(input: {
  generationValue?: DurableImageGeneration;
  prepare?: ReturnType<typeof vi.fn>;
  submit?: ReturnType<typeof vi.fn>;
  getTask?: ReturnType<typeof vi.fn>;
}) {
  const prepare =
    input.prepare ??
    vi.fn().mockResolvedValue({
      providerTaskId: "pt-1",
      stageId: "stage-1",
      status: "submitting",
      externalTaskId: null,
      callbackToken: "token-1",
      submissionAttempts: 1,
      shouldSubmit: true,
    });
  const recordSubmit = vi.fn().mockResolvedValue(undefined);
  const recordSubmitFailure = vi.fn().mockResolvedValue(undefined);
  const recordRetryableSubmitFailure = vi.fn().mockResolvedValue(undefined);
  const recordStatus = vi.fn().mockResolvedValue({ status: "succeeded", error: null });
  const markProcessing = vi.fn().mockResolvedValue(undefined);
  const complete = vi.fn().mockResolvedValue(undefined);
  const fail = vi.fn().mockResolvedValue(undefined);
  const submit =
    input.submit ??
    vi.fn().mockResolvedValue({
      taskId: "kie-1",
      payload: { code: 200, data: { taskId: "kie-1" } },
    });
  const getTask =
    input.getTask ??
    vi.fn().mockResolvedValue({
      taskId: "kie-1",
      model: "gpt-image-2-text-to-image",
      state: "success",
      resultUrls: ["https://example.test/image.png"],
      failCode: null,
      failMessage: null,
      progress: 100,
      creditsConsumed: 10,
      payload: { code: 200, data: { state: "success" } },
    });

  const providerTasks = {
    prepare,
    recordSubmit,
    recordSubmitFailure,
    recordRetryableSubmitFailure,
    recordStatus,
  } as unknown as ProviderTaskRepository;

  const generationImages = {
    get: vi.fn().mockResolvedValue(input.generationValue ?? generation()),
    markProcessing,
    complete,
    fail,
  } as unknown as GenerationImageRepository;

  const market = { submit, getTask } as unknown as KieMarketTaskAdapter;

  return {
    value: {
      providerTasks,
      generationImages,
      generationVideos: {} as GenerationVideoRepository,
      kieMarketTask: market,
      kieVeoTask: null,
      appUrl: "https://factory.example.test",
    } satisfies WorkflowServices,
    mocks: {
      prepare,
      recordSubmit,
      recordSubmitFailure,
      recordRetryableSubmitFailure,
      recordStatus,
      markProcessing,
      complete,
      fail,
      submit,
      getTask,
    },
  };
}

function context(serviceValue: WorkflowServices, state: Record<string, unknown> = {}) {
  return {
    jobId: "job-1",
    workflowKind: "generation_image",
    workflowVersion: 1,
    currentStage: "provider_image",
    state,
    retryCount: 0,
    signal: new AbortController().signal,
    workerId: "worker-1",
    leaseToken: "lease-1",
    services: serviceValue,
  };
}

describe("generation_image@1 provider mapping", () => {
  it("maps GPT Image 2 text-to-image to the KIE Market model", () => {
    expect(buildImageProviderRequest(generation())).toEqual({
      model: "gpt-image-2-text-to-image",
      input: {
        prompt: "A cinematic factory at night",
        aspect_ratio: "16:9",
      },
    });
  });

  it("passes validated GPT Image 2 quality through as provider resolution", () => {
    expect(
      buildImageProviderRequest(
        generation({
          settings: { aspectRatio: "16:9", effectiveQuality: "4K", numOutputs: 1 },
        }),
      ),
    ).toEqual({
      model: "gpt-image-2-text-to-image",
      input: {
        prompt: "A cinematic factory at night",
        aspect_ratio: "16:9",
        resolution: "4K",
      },
    });
  });

  it("maps GPT Image 2 references to image-to-image input_urls", () => {
    expect(
      buildImageProviderRequest(
        generation({ referenceAssets: [{ url: "https://example.test/ref.png" }] }),
      ),
    ).toEqual({
      model: "gpt-image-2-image-to-image",
      input: {
        prompt: "A cinematic factory at night",
        input_urls: ["https://example.test/ref.png"],
        aspect_ratio: "16:9",
      },
    });
  });

  it("maps Nano Banana 2 resolution and references", () => {
    expect(
      buildImageProviderRequest(
        generation({
          modelId: "nano-banana-2",
          settings: { aspectRatio: "1:1", effectiveQuality: "4K", numOutputs: 1 },
          referenceAssets: [{ url: "https://example.test/ref.png" }],
        }),
      ),
    ).toEqual({
      model: "nano-banana-2",
      input: {
        prompt: "A cinematic factory at night",
        image_input: ["https://example.test/ref.png"],
        aspect_ratio: "1:1",
        resolution: "4K",
        output_format: "png",
      },
    });
  });
});

describe("generation_image@1 lifecycle", () => {
  it("never submits again when the durable submission permit was already consumed", async () => {
    const submit = vi.fn();
    const setup = services({
      submit,
      prepare: vi.fn().mockResolvedValue({
        providerTaskId: "pt-existing",
        stageId: "stage-1",
        status: "submitting",
        externalTaskId: null,
        callbackToken: "token-existing",
        submissionAttempts: 1,
        shouldSubmit: false,
      }),
    });

    const outcome = await generationImageV1(context(setup.value));
    expect(outcome.status).toBe("waiting");
    expect(outcome.state?.ambiguous_submit).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it("treats createTask transport ambiguity as callback-only recovery, not a retry", async () => {
    const submit = vi
      .fn()
      .mockRejectedValue(new KieMarketTaskError("socket reset", true, true));
    const setup = services({ submit });

    const outcome = await generationImageV1(context(setup.value));
    expect(outcome.status).toBe("waiting");
    expect(outcome.state?.provider_task_id).toBe("pt-1");
    expect(outcome.state?.external_task_id).toBeNull();
    expect(outcome.state?.ambiguous_submit).toBe(true);
    expect(setup.mocks.recordSubmitFailure).not.toHaveBeenCalled();
    expect(setup.mocks.recordRetryableSubmitFailure).not.toHaveBeenCalled();
  });

  it("reconciles a persisted provider task to generation completion without another submit", async () => {
    const submit = vi.fn();
    const setup = services({ submit });
    const outcome = await generationImageV1(
      context(setup.value, {
        generation_id: "gen-1",
        variant_index: 0,
        outputs: [],
        provider_task_id: "pt-1",
        external_task_id: "kie-1",
      }),
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.result?.outputs).toEqual([
      { url: "https://example.test/image.png", kind: "image" },
    ]);
    expect(submit).not.toHaveBeenCalled();
    expect(setup.mocks.recordStatus).toHaveBeenCalledOnce();
    expect(setup.mocks.complete).toHaveBeenCalledOnce();
  });

  it("schedules a fresh provider attempt after a terminal HTTP 500-style failure", async () => {
    const first = services({
      getTask: vi.fn().mockResolvedValue({
        taskId: "kie-old",
        model: "gpt-image-2-text-to-image",
        state: "fail",
        resultUrls: [],
        failCode: "500",
        failMessage: "Internal Error",
        progress: 100,
        creditsConsumed: 10,
        payload: { code: 200, data: { state: "fail", failCode: "500" } },
      }),
    });

    const retryScheduled = await generationImageV1(
      context(first.value, {
        generation_id: "gen-1",
        variant_index: 0,
        outputs: [],
        provider_task_id: "pt-old",
        external_task_id: "kie-old",
      }),
    );

    expect(retryScheduled.status).toBe("waiting");
    expect(retryScheduled.state?.provider_task_id).toBeNull();
    expect(retryScheduled.state?.external_task_id).toBeNull();
    expect(retryScheduled.state?.provider_retry_count).toBe(1);
    expect(retryScheduled.eventType).toBe("provider.retry_scheduled");
    expect(first.mocks.fail).not.toHaveBeenCalled();

    const prepare = vi.fn().mockResolvedValue({
      providerTaskId: "pt-retry-1",
      stageId: "stage-retry-1",
      status: "submitting",
      externalTaskId: null,
      callbackToken: "token-retry-1",
      submissionAttempts: 1,
      shouldSubmit: true,
    });
    const second = services({ prepare });
    const retrySubmitted = await generationImageV1(
      context(second.value, retryScheduled.state ?? {}),
    );

    expect(retrySubmitted.status).toBe("waiting");
    expect(retrySubmitted.state?.provider_task_id).toBe("pt-retry-1");
    expect(retrySubmitted.state?.external_task_id).toBe("kie-1");
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        stageAttempt: 11,
        submissionKey: "generation:gen-1:image:v1:0:retry:1",
      }),
    );
    expect(second.mocks.submit).toHaveBeenCalledOnce();
  });

  it("retries a definite non-ambiguous 429 submit rejection without failing the generation", async () => {
    const submit = vi.fn().mockRejectedValue(
      new KieMarketTaskError("KIE task creation failed: rate limited", true, false, 429, "Too Many Requests"),
    );
    const setup = services({ submit });

    const outcome = await generationImageV1(context(setup.value));

    expect(outcome.status).toBe("waiting");
    expect(outcome.state?.provider_retry_count).toBe(1);
    expect(outcome.state?.provider_task_id).toBeNull();
    expect(setup.mocks.recordRetryableSubmitFailure).toHaveBeenCalledOnce();
    expect(setup.mocks.recordSubmitFailure).not.toHaveBeenCalled();
    expect(setup.mocks.fail).not.toHaveBeenCalled();
  });

  it("stops after two provider retries and fails the generation on a third transient failure", async () => {
    const setup = services({
      getTask: vi.fn().mockResolvedValue({
        taskId: "kie-retry-2",
        model: "gpt-image-2-text-to-image",
        state: "fail",
        resultUrls: [],
        failCode: "503",
        failMessage: "Service Unavailable",
        progress: 100,
        creditsConsumed: 10,
        payload: { code: 200, data: { state: "fail", failCode: "503" } },
      }),
    });

    const outcome = await generationImageV1(
      context(setup.value, {
        generation_id: "gen-1",
        variant_index: 0,
        outputs: [],
        provider_task_id: "pt-retry-2",
        external_task_id: "kie-retry-2",
        provider_retry_count: 2,
      }),
    );

    expect(outcome.status).toBe("failed");
    expect(setup.mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "503" }),
    );
    expect(outcome.error?.details).toEqual(
      expect.objectContaining({ provider_retry_count: 2, max_provider_retries: 2 }),
    );
  });

  it("registers all durable workflows", () => {
    expect(listRegisteredWorkflows()).toEqual([
      "concept_council_member@1",
      "core_smoke@1",
      "external_research_scout@1",
      "game_discovery_batch@1",
      "game_discovery_batch@2",
      "game_discovery_batch@3",
      "gameplay_authenticity_planning_smoke@1",
      "gameplay_reference_index@1",
      "gameplay_reference_retrieval_smoke@1",
      "generation_image@1",
      "generation_video@1",
    ]);
  });
});