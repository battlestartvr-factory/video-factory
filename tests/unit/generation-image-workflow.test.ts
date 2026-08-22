import { describe, expect, it, vi } from "vitest";
import { generationImageV1 } from "../../worker/workflows/generation-image-v1";
import { listRegisteredWorkflows } from "../../worker/workflows/registry";
import type { WorkflowTickContext } from "../../worker/workflows/types";

function setupContext(overrides: Partial<WorkflowTickContext> = {}) {
  const mocks = {
    getGeneration: vi.fn(),
    prepareSubmission: vi.fn(),
    markSubmitted: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    getProviderTask: vi.fn(),
    register: vi.fn(),
    recordStatus: vi.fn(),
    submit: vi.fn(),
  };

  const context = {
    jobId: "job-1",
    workflowKind: "generation_image",
    workflowVersion: 1,
    currentStage: "generation_image_submit",
    state: { generation_id: "generation-1" },
    retryCount: 0,
    signal: new AbortController().signal,
    workerId: "worker-test",
    leaseToken: "lease-test",
    services: {
      generationImages: {
        getGeneration: mocks.getGeneration,
        prepareSubmission: mocks.prepareSubmission,
        markSubmitted: mocks.markSubmitted,
        complete: mocks.complete,
        fail: mocks.fail,
      },
      providerTasks: {
        getByGeneration: mocks.getProviderTask,
        register: mocks.register,
        recordStatus: mocks.recordStatus,
      },
      kieMarketTask: { createTask: mocks.submit },
    },
    ...overrides,
  } as unknown as WorkflowTickContext;

  return { context, mocks };
}

describe("generation_image@1 lifecycle", () => {
  it("maps GPT Image 2 text-to-image to the KIE Market model", async () => {
    const setup = setupContext();
    setup.mocks.getGeneration.mockResolvedValue({
      id: "generation-1",
      status: "queued",
      modelId: "gpt-image-2",
      prompt: "a co-op gameplay frame",
      settings: { aspectRatio: "16:9", effectiveQuality: "1K" },
      referenceUrls: [],
    });
    setup.mocks.prepareSubmission.mockResolvedValue({ acquired: true, status: "submitting" });
    setup.mocks.submit.mockResolvedValue({ taskId: "kie-1", raw: {} });
    setup.mocks.register.mockResolvedValue({ id: "pt-1" });
    setup.mocks.markSubmitted.mockResolvedValue(undefined);

    const outcome = await generationImageV1(setup.context);

    expect(setup.mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-image-2",
        input: expect.objectContaining({
          prompt: "a co-op gameplay frame",
          aspect_ratio: "16:9",
          quality: "1K",
        }),
      }),
    );
    expect(outcome.status).toBe("waiting");
  });

  it("passes validated GPT Image 2 quality through as provider resolution", async () => {
    const setup = setupContext();
    setup.mocks.getGeneration.mockResolvedValue({
      id: "generation-1",
      status: "queued",
      modelId: "gpt-image-2",
      prompt: "quality test",
      settings: { aspectRatio: "16:9", effectiveQuality: "2K" },
      referenceUrls: [],
    });
    setup.mocks.prepareSubmission.mockResolvedValue({ acquired: true, status: "submitting" });
    setup.mocks.submit.mockResolvedValue({ taskId: "kie-1", raw: {} });
    setup.mocks.register.mockResolvedValue({ id: "pt-1" });
    setup.mocks.markSubmitted.mockResolvedValue(undefined);

    await generationImageV1(setup.context);

    expect(setup.mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ quality: "2K" }) }),
    );
  });

  it("maps GPT Image 2 references to image-to-image input_urls", async () => {
    const setup = setupContext();
    setup.mocks.getGeneration.mockResolvedValue({
      id: "generation-1",
      status: "queued",
      modelId: "gpt-image-2",
      prompt: "reference test",
      settings: { aspectRatio: "16:9", effectiveQuality: "1K" },
      referenceUrls: ["https://example.test/ref.png"],
    });
    setup.mocks.prepareSubmission.mockResolvedValue({ acquired: true, status: "submitting" });
    setup.mocks.submit.mockResolvedValue({ taskId: "kie-1", raw: {} });
    setup.mocks.register.mockResolvedValue({ id: "pt-1" });
    setup.mocks.markSubmitted.mockResolvedValue(undefined);

    await generationImageV1(setup.context);

    expect(setup.mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ input_urls: ["https://example.test/ref.png"] }),
      }),
    );
  });

  it("maps Nano Banana 2 resolution and references", async () => {
    const setup = setupContext();
    setup.mocks.getGeneration.mockResolvedValue({
      id: "generation-1",
      status: "queued",
      modelId: "nano-banana-2",
      prompt: "legacy reference test",
      settings: { aspectRatio: "16:9", effectiveQuality: "2K" },
      referenceUrls: ["https://example.test/ref.png"],
    });
    setup.mocks.prepareSubmission.mockResolvedValue({ acquired: true, status: "submitting" });
    setup.mocks.submit.mockResolvedValue({ taskId: "kie-1", raw: {} });
    setup.mocks.register.mockResolvedValue({ id: "pt-1" });
    setup.mocks.markSubmitted.mockResolvedValue(undefined);

    await generationImageV1(setup.context);

    expect(setup.mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          resolution: "2K",
          image_urls: ["https://example.test/ref.png"],
        }),
      }),
    );
  });

  it("never submits again when the durable submission permit was already consumed", async () => {
    const setup = setupContext();
    setup.mocks.getGeneration.mockResolvedValue({
      id: "generation-1",
      status: "running",
      modelId: "gpt-image-2",
      prompt: "test",
      settings: {},
      referenceUrls: [],
    });
    setup.mocks.prepareSubmission.mockResolvedValue({ acquired: false, status: "submitted" });
    setup.mocks.getProviderTask.mockResolvedValue(null);

    const outcome = await generationImageV1(setup.context);

    expect(setup.mocks.submit).not.toHaveBeenCalled();
    expect(outcome.status).toBe("waiting");
  });

  it("treats createTask transport ambiguity as callback-only recovery, not a retry", async () => {
    const setup = setupContext();
    setup.mocks.getGeneration.mockResolvedValue({
      id: "generation-1",
      status: "queued",
      modelId: "gpt-image-2",
      prompt: "test",
      settings: {},
      referenceUrls: [],
    });
    setup.mocks.prepareSubmission.mockResolvedValue({ acquired: true, status: "submitting" });
    setup.mocks.submit.mockRejectedValue(new Error("network reset after submit"));

    const outcome = await generationImageV1(setup.context);

    expect(outcome.status).toBe("waiting");
    expect(setup.mocks.submit).toHaveBeenCalledOnce();
  });

  it("reconciles a persisted provider task to generation completion without another submit", async () => {
    const setup = setupContext({ currentStage: "generation_image_wait" });
    setup.mocks.getGeneration.mockResolvedValue({
      id: "generation-1",
      status: "running",
      modelId: "gpt-image-2",
      prompt: "test",
      settings: {},
      referenceUrls: [],
    });
    setup.mocks.getProviderTask.mockResolvedValue({
      id: "pt-1",
      externalTaskId: "kie-1",
      status: "completed",
      output: { resultUrls: ["https://example.test/image.png"] },
    });
    setup.mocks.recordStatus.mockResolvedValue(undefined);
    setup.mocks.complete.mockResolvedValue(undefined);

    const outcome = await generationImageV1(setup.context);

    expect(setup.mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        provider_task_id: "pt-1",
        external_task_id: "kie-1",
      }),
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.result?.outputs).toEqual([
      { url: "https://example.test/image.png", kind: "image" },
    ]);
    expect(setup.mocks.submit).not.toHaveBeenCalled();
    expect(setup.mocks.recordStatus).toHaveBeenCalledOnce();
    expect(setup.mocks.complete).toHaveBeenCalledOnce();
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