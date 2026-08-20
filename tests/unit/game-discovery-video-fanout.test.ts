import { describe, expect, it, vi } from "vitest";
import { buildGameplayAssetGraph } from "../../lib/game-discovery/asset-graph";
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

function referenceApproval(input: {
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
    outputs: [{ url: `https://example.com/${input.shotId}.png`, driveFileId: `drive-image-${input.shotId}` }],
    errorMessage: null,
    modelId: "nano-banana-2",
    decision: input.decision,
    reviewId: `reference-review-${input.shotId}`,
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
    outputs: input.status === "completed"
      ? [{ url: `https://example.com/${input.shotId}.mp4`, driveFileId: `drive-video-${input.shotId}` }]
      : [],
    errorMessage: null,
    modelId: "kling-3",
  };
}

function videoApproval(input: {
  shotId: string;
  referenceGenerationId: string;
  decision: "approve" | "reject" | "revise" | null;
}) {
  return {
    ...video({ shotId: input.shotId, referenceGenerationId: input.referenceGenerationId, status: "completed" }),
    decision: input.decision,
    reviewId: input.decision ? `video-review-${input.shotId}` : null,
    rawFeedback: input.decision === "revise" ? "Make the co-op action clearer" : null,
    structuredFeedback: input.decision === "revise"
      ? { mustShow: ["clear co-op dependency"], mustAvoid: [], errorTags: [] }
      : {},
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

describe("Stage 4 human-controlled gameplay video fanout", () => {
  it("fails closed when video pending is reached without the human reference gate", async () => {
    const result = await gameDiscoveryBatchStage4VideoV1(
      context({ stage: "video_generation_pending", gameDiscovery: {}, gameDiscoveryVideo: {} }),
    );

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "DISCOVERY_VIDEO_HUMAN_GATE_REQUIRED" });
  });

  it("admits video only for current human-approved references", async () => {
    const approved = referenceApproval({ shotId: "shot-1", generationId: "reference-1", decision: "approve" });
    const rejected = referenceApproval({ shotId: "shot-2", generationId: "reference-2", decision: "reject" });
    const createApprovedVideo = vi.fn(async () => ({ generationId: "video-1", factoryJobId: "video-job-1", duplicate: false }));

    const result = await gameDiscoveryBatchStage4VideoV1(
      context({
        stage: "video_generation_pending",
        state: { human_reference_gate_passed: true },
        gameDiscovery: {
          getReferenceApprovalStage: async () => ({ allReviewed: true, allApproved: false, items: [approved, rejected] }),
        },
        gameDiscoveryVideo: {
          getGameplayVideoStage: async () => ({ items: [], requestCount: 0, allTerminal: false, allCompleted: false }),
          createApprovedVideo,
        },
      }),
    );

    expect(createApprovedVideo).toHaveBeenCalledTimes(1);
    expect(createApprovedVideo).toHaveBeenCalledWith(expect.objectContaining({ shotId: "shot-1", referenceGenerationId: "reference-1" }));
    expect(result.currentStage).toBe("video_generation_waiting");
    expect(result.state).toMatchObject({ video_approval_required: true, asset_graph_locked: true, assembly_locked: true });
  });

  it("parks completed gameplay videos at a human review gate instead of AssetGraph", async () => {
    const approved = referenceApproval({ shotId: "shot-1", generationId: "reference-1", decision: "approve" });
    const completedVideo = video({ shotId: "shot-1", referenceGenerationId: "reference-1", status: "completed" });

    const result = await gameDiscoveryBatchStage4VideoV1(
      context({
        stage: "video_generation_waiting",
        state: { human_reference_gate_passed: true },
        gameDiscovery: {
          getReferenceApprovalStage: async () => ({ allReviewed: true, allApproved: true, items: [approved] }),
        },
        gameDiscoveryVideo: {
          getGameplayVideoStage: async () => ({ items: [completedVideo], requestCount: 1, allTerminal: true, allCompleted: true }),
        },
      }),
    );

    expect(result.status).toBe("waiting");
    expect(result.currentStage).toBe("human_video_approval_pending");
    expect(result.nextActionAt).toBeNull();
    expect(result.eventPayload).toMatchObject({ human_video_gate_required: true, ai_video_rejection_enabled: false });
  });

  it("keeps a partial set of video decisions parked until every current video is reviewed", async () => {
    const result = await gameDiscoveryBatchStage4VideoV1(
      context({
        stage: "human_video_approval_pending",
        gameDiscovery: {},
        gameDiscoveryVideo: {
          getGameplayVideoApprovalStage: async () => ({
            requestCount: 2,
            allReviewed: false,
            allApproved: false,
            items: [
              videoApproval({ shotId: "shot-1", referenceGenerationId: "reference-1", decision: "approve" }),
              videoApproval({ shotId: "shot-2", referenceGenerationId: "reference-2", decision: null }),
            ],
          }),
        },
      }),
    );

    expect(result.currentStage).toBe("human_video_approval_pending");
    expect(result.nextActionAt).toBeNull();
    expect(result.state).toMatchObject({ human_video_gate_passed: false, asset_graph_locked: true });
  });

  it("routes a human revise decision to an explicit revision stage without automatic regeneration", async () => {
    const result = await gameDiscoveryBatchStage4VideoV1(
      context({
        stage: "human_video_approval_pending",
        gameDiscovery: {},
        gameDiscoveryVideo: {
          getGameplayVideoApprovalStage: async () => ({
            requestCount: 1,
            allReviewed: true,
            allApproved: false,
            items: [videoApproval({ shotId: "shot-1", referenceGenerationId: "reference-1", decision: "revise" })],
          }),
        },
      }),
    );

    expect(result.currentStage).toBe("video_revision_pending");
    expect(result.nextActionAt).toEqual(expect.any(String));
    expect(result.eventPayload).toMatchObject({
      human_feedback_memory_saved: true,
      automatic_video_regeneration: false,
    });
  });

  it("advances only human-approved gameplay videos to AssetGraph", async () => {
    const result = await gameDiscoveryBatchStage4VideoV1(
      context({
        stage: "human_video_approval_pending",
        gameDiscovery: {},
        gameDiscoveryVideo: {
          getGameplayVideoApprovalStage: async () => ({
            requestCount: 2,
            allReviewed: true,
            allApproved: false,
            items: [
              videoApproval({ shotId: "shot-1", referenceGenerationId: "reference-1", decision: "approve" }),
              videoApproval({ shotId: "shot-2", referenceGenerationId: "reference-2", decision: "reject" }),
            ],
          }),
        },
      }),
    );

    expect(result.currentStage).toBe("asset_graph_pending");
    expect(result.state).toMatchObject({
      human_video_gate_passed: true,
      approved_video_generation_ids: ["video-shot-1"],
      rejected_video_generation_ids: ["video-shot-2"],
      asset_graph_locked: false,
    });
  });

  it("persists a graph only for a human-approved current gameplay video", async () => {
    const approvedReference = referenceApproval({ shotId: "shot-1", generationId: "reference-1", decision: "approve" });
    const approvedVideo = videoApproval({ shotId: "shot-1", referenceGenerationId: "reference-1", decision: "approve" });
    const persistAssetGraph = vi.fn(async () => undefined);

    const result = await gameDiscoveryBatchStage4VideoV1(
      context({
        stage: "asset_graph_pending",
        gameDiscovery: {
          getReferenceApprovalStage: async () => ({ allReviewed: true, allApproved: true, items: [approvedReference] }),
        },
        gameDiscoveryVideo: {
          getGameplayVideoApprovalStage: async () => ({ requestCount: 1, allReviewed: true, allApproved: true, items: [approvedVideo] }),
          persistAssetGraph,
        },
      }),
    );

    expect(persistAssetGraph).toHaveBeenCalledTimes(1);
    expect(persistAssetGraph).toHaveBeenCalledWith(expect.objectContaining({
      conceptRunId: "concept-run-shot-1",
      assetGraph: expect.objectContaining({ schema: "asset_graph", version: 1 }),
    }));
    expect(result.currentStage).toBe("assembly_pending");
  });

  it("builds the exact reference to approved-video lineage with Drive evidence", () => {
    const graph = buildGameplayAssetGraph({
      objectiveRunId: "root-run",
      conceptRunId: "concept-run",
      conceptId: "concept-1",
      momentId: "moment-1",
      shotId: "shot-1",
      approvedReferenceGenerationId: "reference-1",
      approvedReferenceOutputs: [{ driveFileId: "drive-image-1" }],
      videoGenerationId: "video-1",
      videoOutputs: [{ driveFileId: "drive-video-1" }],
    });

    expect(graph.edges).toContainEqual({ from: "reference-image", to: "gameplay-video", relation: "keyframe_for" });
  });

  it("schedules video admission immediately after human reference approval", async () => {
    const approved = referenceApproval({ shotId: "shot-1", generationId: "reference-1", decision: "approve" });
    const result = await gameDiscoveryBatchStage4VideoV1(
      context({
        stage: "human_reference_approval_pending",
        gameDiscovery: {
          getReferenceApprovalStage: async () => ({ allReviewed: true, allApproved: true, items: [approved] }),
        },
      }),
    );

    expect(result.currentStage).toBe("video_generation_pending");
    expect(result.nextActionAt).toEqual(expect.any(String));
    expect(result.enqueueReason).toBe("approved_gameplay_video_admission");
  });
});
