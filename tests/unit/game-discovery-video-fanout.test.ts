import { describe, expect, it, vi } from "vitest";
import { gameDiscoveryBatchStage4VideoV1 } from "../../worker/workflows/game-discovery-batch-stage4-video-v1";
import type { WorkflowTickContext } from "../../worker/workflows/types";

const objective = {
  schema: "discovery_objective" as const,
  version: 1 as const,
  objectiveId: "objective-video-fanout",
  title: "Approved video fanout",
  searchIntent: "Generate video only from an explicitly approved gameplay reference.",
  playerCount: { min: 2 as const, max: 4 as const },
  platform: "pc_steam" as const,
  desiredNovelty: "balanced" as const,
  conceptCount: 2,
  maxConceptsToPrototype: 2,
  constraints: {},
};

function approval(input: {
  shotId: string;
  generationId: string;
  decision: "approve" | "reject" | "revise";
}) {
  return {
    shotId: input.shotId,
    conceptId: `concept-${input.shotId}`,
    momentId: `moment-${input.shotId}`,
    conceptRunId: `concept-run-${input.shotId}`,
    generationId: input.generationId,
    factoryJobId: `reference-job-${input.shotId}`,
    status: "completed",
    outputs: [{ url: `https://example.com/${input.shotId}.png` }],
    errorMessage: null,
    modelId: "nano-banana-2",
    decision: input.decision,
    reviewId: `review-${input.shotId}`,
    rawFeedback: null,
    structuredFeedback: {},
  };
}

function video(input: {
  shotId: string;
  referenceGenerationId: string;
  status?: string;
}) {
  return {
    shotId: input.shotId,
    conceptId: `concept-${input.shotId}`,
    momentId: `moment-${input.shotId}`,
    conceptRunId: `concept-run-${input.shotId}`,
    generationId: `video-${input.shotId}`,
    factoryJobId: `video-job-${input.shotId}`,
    approvedReferenceGenerationId: input.referenceGenerationId,
    status: input.status ?? "processing",
    outputs: input.status === "completed" ? [{ url: `https://example.com/${input.shotId}.mp4` }] : [],
    errorMessage: null,
    modelId: "kling-3",
  };
}

function context(input: {
  stage: string;
  state?: Record<string, unknown>;
  gameDiscovery?: Record<string, unknown>;
  gameDiscoveryVideo?: Record<string, unknown>;
}): WorkflowTickContext {
  return {
    jobId: "11111111-1111-4111-8111-111111111111",
    workflowKind: "game_discovery_batch",
    workflowVersion: 1,
    currentStage: input.stage,
    state: {
      creative_run_id: "22222222-2222-4222-8222-222222222222",
      discovery_objective: objective,
      ...input.state,
    },
    retryCount: 0,
    signal: new AbortController().signal,
    services: {
      gameDiscovery: input.gameDiscovery,
      gameDiscoveryVideo: input.gameDiscoveryVideo,
    } as unknown as NonNullable<WorkflowTickContext["services"]>,
  };
}

describe("Stage 4 approved gameplay video fanout", () => {
  it("fails closed when video pending is reached without the human gate", async () => {
    const result = await gameDiscoveryBatchStage4VideoV1(
      context({
        stage: "video_generation_pending",
        gameDiscovery: {},
        gameDiscoveryVideo: {},
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "DISCOVERY_VIDEO_HUMAN_GATE_REQUIRED" });
    expect(result.state).toMatchObject({ video_generation_locked: true });
  });

  it("admits video only for current human-approved references", async () => {
    const approved = approval({ shotId: "shot-1", generationId: "reference-1", decision: "approve" });
    const rejected = approval({ shotId: "shot-2", generationId: "reference-2", decision: "reject" });
    const createApprovedVideo = vi.fn(async () => ({
      generationId: "video-1",
      factoryJobId: "video-job-1",
      duplicate: false,
    }));

    const result = await gameDiscoveryBatchStage4VideoV1(
      context({
        stage: "video_generation_pending",
        state: { human_reference_gate_passed: true },
        gameDiscovery: {
          getReferenceApprovalStage: async () => ({
            allReviewed: true,
            allApproved: false,
            items: [approved, rejected],
          }),
        },
        gameDiscoveryVideo: {
          getGameplayVideoStage: async () => ({
            items: [],
            requestCount: 0,
            allTerminal: false,
            allCompleted: false,
          }),
          createApprovedVideo,
        },
      }),
    );

    expect(createApprovedVideo).toHaveBeenCalledTimes(1);
    expect(createApprovedVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        shotId: "shot-1",
        referenceGenerationId: "reference-1",
      }),
    );
    expect(result.currentStage).toBe("video_generation_waiting");
    expect(result.enqueueReason).toBe("gameplay_video_reconcile");
    expect(result.eventPayload).toMatchObject({ expected_count: 1 });
  });

  it("is restart-safe and does not re-admit a matching existing video child", async () => {
    const approved = approval({ shotId: "shot-1", generationId: "reference-1", decision: "approve" });
    const createApprovedVideo = vi.fn();

    const result = await gameDiscoveryBatchStage4VideoV1(
      context({
        stage: "video_generation_pending",
        state: { human_reference_gate_passed: true },
        gameDiscovery: {
          getReferenceApprovalStage: async () => ({
            allReviewed: true,
            allApproved: true,
            items: [approved],
          }),
        },
        gameDiscoveryVideo: {
          getGameplayVideoStage: async () => ({
            items: [video({ shotId: "shot-1", referenceGenerationId: "reference-1" })],
            requestCount: 1,
            allTerminal: false,
            allCompleted: false,
          }),
          createApprovedVideo,
        },
      }),
    );

    expect(createApprovedVideo).not.toHaveBeenCalled();
    expect(result.currentStage).toBe("video_generation_waiting");
    expect(result.eventPayload).toMatchObject({ admitted_count: 0, existing_count: 1 });
  });

  it("fails closed if an existing video is tied to a stale reference", async () => {
    const approved = approval({ shotId: "shot-1", generationId: "reference-new", decision: "approve" });

    const result = await gameDiscoveryBatchStage4VideoV1(
      context({
        stage: "video_generation_pending",
        state: { human_reference_gate_passed: true },
        gameDiscovery: {
          getReferenceApprovalStage: async () => ({
            allReviewed: true,
            allApproved: true,
            items: [approved],
          }),
        },
        gameDiscoveryVideo: {
          getGameplayVideoStage: async () => ({
            items: [video({ shotId: "shot-1", referenceGenerationId: "reference-old" })],
            requestCount: 1,
            allTerminal: false,
            allCompleted: false,
          }),
          createApprovedVideo: vi.fn(),
        },
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "DISCOVERY_VIDEO_STALE_REFERENCE" });
    expect(result.state).toMatchObject({ video_generation_locked: true });
  });

  it("parks completed approved videos at the AssetGraph boundary", async () => {
    const approved = approval({ shotId: "shot-1", generationId: "reference-1", decision: "approve" });
    const completedVideo = video({
      shotId: "shot-1",
      referenceGenerationId: "reference-1",
      status: "completed",
    });

    const result = await gameDiscoveryBatchStage4VideoV1(
      context({
        stage: "video_generation_waiting",
        state: { human_reference_gate_passed: true },
        gameDiscovery: {
          getReferenceApprovalStage: async () => ({
            allReviewed: true,
            allApproved: true,
            items: [approved],
          }),
        },
        gameDiscoveryVideo: {
          getGameplayVideoStage: async () => ({
            items: [completedVideo],
            requestCount: 1,
            allTerminal: true,
            allCompleted: true,
          }),
        },
      }),
    );

    expect(result.status).toBe("waiting");
    expect(result.currentStage).toBe("asset_graph_pending");
    expect(result.nextActionAt).toBeNull();
    expect(result.state).toMatchObject({ gameplay_videos: [completedVideo] });
  });

  it("schedules the video admission tick immediately after human approval", async () => {
    const approved = approval({ shotId: "shot-1", generationId: "reference-1", decision: "approve" });

    const result = await gameDiscoveryBatchStage4VideoV1(
      context({
        stage: "human_reference_approval_pending",
        gameDiscovery: {
          getReferenceApprovalStage: async () => ({
            allReviewed: true,
            allApproved: true,
            items: [approved],
          }),
        },
      }),
    );

    expect(result.currentStage).toBe("video_generation_pending");
    expect(result.nextActionAt).toEqual(expect.any(String));
    expect(result.enqueueReason).toBe("approved_gameplay_video_admission");
  });
});
