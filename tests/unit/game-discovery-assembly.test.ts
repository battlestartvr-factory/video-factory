import { describe, expect, it, vi } from "vitest";
import { gameDiscoveryBatchStage4AssemblyV1 } from "../../worker/workflows/game-discovery-batch-stage4-assembly-v1";
import type { GameplayPrototypeAssembly } from "../../lib/game-discovery/assembly";
import type { WorkflowTickContext } from "../../worker/workflows/types";

const rootRunId = "22222222-2222-4222-8222-222222222222";
const rootJobId = "11111111-1111-4111-8111-111111111111";
const conceptRunId = "33333333-3333-4333-8333-333333333333";

function approval() {
  return {
    shotId: "shot-1",
    conceptId: "concept-1",
    momentId: "moment-1",
    conceptRunId,
    generationId: "44444444-4444-4444-8444-444444444444",
    factoryJobId: "reference-job-1",
    status: "completed",
    outputs: [{ driveFileId: "drive-image" }],
    errorMessage: null,
    modelId: "nano-banana-2",
    decision: "approve" as const,
    reviewId: "review-1",
    rawFeedback: null,
    structuredFeedback: {},
  };
}

function approvedVideo() {
  return {
    shotId: "shot-1",
    conceptId: "concept-1",
    momentId: "moment-1",
    conceptRunId,
    generationId: "55555555-5555-4555-8555-555555555555",
    factoryJobId: "video-job-1",
    approvedReferenceGenerationId: "44444444-4444-4444-8444-444444444444",
    status: "completed",
    outputs: [{ driveFileId: "drive-video" }],
    errorMessage: null,
    modelId: "kling-3",
    decision: "approve" as const,
    reviewId: "video-review-1",
    rawFeedback: "Good gameplay read",
    structuredFeedback: {},
  };
}

function artifact(): GameplayPrototypeAssembly {
  return {
    schema: "gameplay_short_assembly",
    version: 1,
    rootCreativeRunId: rootRunId,
    conceptRunId,
    conceptId: "concept-1",
    inputVideoGenerationIds: ["55555555-5555-4555-8555-555555555555"],
    driveFileId: "drive-short",
    driveWebUrl: "https://drive.example/short",
    filename: `social-edit-${conceptRunId}.mp4`,
    mimeType: "video/mp4",
    sizeBytes: 123456,
    sha256: "a".repeat(64),
    durationSeconds: 5,
    width: 1080,
    height: 1920,
    fps: 30,
    videoCodec: "h264",
    audioIncluded: false,
    landscapeMaster: {
      driveFileId: "drive-master",
      driveWebUrl: "https://drive.example/master",
      filename: `gameplay-master-${conceptRunId}.mp4`,
      mimeType: "video/mp4",
      sizeBytes: 123456,
      sha256: "b".repeat(64),
      durationSeconds: 5,
      width: 1920,
      height: 1080,
      fps: 30,
      videoCodec: "h264",
      archivedAt: "2026-08-18T10:00:00.000Z",
    },
    assemblyPolicy: {
      engine: "ffmpeg",
      width: 1080,
      height: 1920,
      sourceWidth: 1920,
      sourceHeight: 1080,
      fps: 30,
      maxClipSeconds: 5,
      videoCodec: "libx264",
      pixelFormat: "yuv420p",
      audio: false,
      verticalization: "full_landscape_frame_over_blurred_background",
      gameplayCrop: false,
    },
    archivedAt: "2026-08-18T10:00:00.000Z",
  };
}

function context(input: {
  stage: string;
  existing?: GameplayPrototypeAssembly[];
  assemble?: ReturnType<typeof vi.fn>;
  persistAssembly?: ReturnType<typeof vi.fn>;
  finalize?: ReturnType<typeof vi.fn>;
}): WorkflowTickContext {
  const assemble = input.assemble ?? vi.fn(async () => artifact());
  const persistAssembly = input.persistAssembly ?? vi.fn(async () => undefined);
  const finalize = input.finalize ?? vi.fn(async () => ({
    schema: "game_discovery_prototype_result",
    version: 1,
    prototypeCount: 1,
  }));
  return {
    jobId: rootJobId,
    workflowKind: "game_discovery_batch",
    workflowVersion: 1,
    currentStage: input.stage,
    state: { creative_run_id: rootRunId, human_reference_gate_passed: true, human_video_gate_passed: true },
    retryCount: 0,
    signal: new AbortController().signal,
    services: {
      gameDiscovery: {
        getReferenceApprovalStage: async () => ({
          allReviewed: true,
          allApproved: true,
          items: [approval()],
        }),
      },
      gameDiscoveryVideo: {
        getGameplayVideoApprovalStage: async () => ({
          items: [approvedVideo()],
          requestCount: 1,
          allReviewed: true,
          allApproved: true,
        }),
        getAssemblyStage: async () => ({
          items: input.existing ?? [],
          assemblyCount: input.existing?.length ?? 0,
        }),
        persistAssembly,
        finalizeDiscoveryBatch: finalize,
      },
      gameDiscoveryAssembly: { assembleConceptPrototype: assemble },
    } as unknown as NonNullable<WorkflowTickContext["services"]>,
  };
}

describe("Stage 4 deterministic prototype assembly", () => {
  it("assembles a missing prototype only from a human-approved gameplay video", async () => {
    const assemble = vi.fn(async () => artifact());
    const persistAssembly = vi.fn(async () => undefined);
    const result = await gameDiscoveryBatchStage4AssemblyV1(
      context({ stage: "assembly_pending", assemble, persistAssembly }),
    );

    expect(assemble).toHaveBeenCalledTimes(1);
    expect(assemble).toHaveBeenCalledWith(expect.objectContaining({
      rootCreativeRunId: rootRunId,
      conceptRunId,
      videoGenerationIds: ["55555555-5555-4555-8555-555555555555"],
    }));
    expect(persistAssembly).toHaveBeenCalledTimes(1);
    expect(result.currentStage).toBe("prototype_finalization_pending");
    expect(result.eventPayload).toMatchObject({
      approved_video_generation_ids: ["55555555-5555-4555-8555-555555555555"],
    });
  });

  it("is restart-safe and reuses a matching persisted prototype", async () => {
    const assemble = vi.fn();
    const persistAssembly = vi.fn();
    const result = await gameDiscoveryBatchStage4AssemblyV1(
      context({ stage: "assembly_pending", existing: [artifact()], assemble, persistAssembly }),
    );

    expect(assemble).not.toHaveBeenCalled();
    expect(persistAssembly).not.toHaveBeenCalled();
    expect(result.currentStage).toBe("prototype_finalization_pending");
    expect(result.eventPayload).toMatchObject({ reused_count: 1 });
  });

  it("fails closed when a persisted prototype points at a stale video", async () => {
    const stale = artifact();
    stale.inputVideoGenerationIds = ["66666666-6666-4666-8666-666666666666"];
    const result = await gameDiscoveryBatchStage4AssemblyV1(
      context({ stage: "assembly_pending", existing: [stale] }),
    );

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "DISCOVERY_ASSEMBLY_STALE_VIDEO" });
  });

  it("finalizes the durable batch after all human-approved prototype assemblies are persisted", async () => {
    const finalize = vi.fn(async () => ({
      schema: "game_discovery_prototype_result",
      version: 1,
      prototypeCount: 1,
      assemblies: { "concept-1": artifact() },
    }));
    const result = await gameDiscoveryBatchStage4AssemblyV1(
      context({ stage: "prototype_finalization_pending", finalize }),
    );

    expect(finalize).toHaveBeenCalledWith({ rootJobId, rootCreativeRunId: rootRunId });
    expect(result.status).toBe("completed");
    expect(result.currentStage).toBe("completed");
    expect(result.progress).toBe(100);
  });
});
