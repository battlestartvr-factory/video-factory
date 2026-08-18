import { describe, expect, it, vi } from "vitest";
import { gameDiscoveryBatchStage4V1 } from "../../worker/workflows/game-discovery-batch-stage4-v1";
import type { WorkflowTickContext } from "../../worker/workflows/types";

const objective = {
  schema: "discovery_objective" as const,
  version: 1 as const,
  objectiveId: "objective-reference-gate",
  title: "Reference gate",
  searchIntent: "Test one readable co-op gameplay reference before video.",
  playerCount: { min: 2 as const, max: 4 as const },
  platform: "pc_steam" as const,
  desiredNovelty: "balanced" as const,
  conceptCount: 2,
  maxConceptsToPrototype: 1,
  constraints: {},
};

const shot = {
  schema: "gameplay_shot" as const,
  version: 1 as const,
  shotId: "shot-1",
  momentId: "moment-1",
  order: 0,
  durationSec: 5,
  purpose: "mechanic" as const,
  actors: ["Driver", "Rigger"],
  action: "Two players coordinate one unstable load.",
  camera: "Readable third-person gameplay camera.",
  environment: "Compact test room.",
  continuity: { preserve: [] },
  expectedEvidence: ["both players visible"],
  generationPlan: {
    keyframeRequired: true,
    imageModel: "nano-banana-2" as const,
    videoModel: "kling-3",
    videoMode: "image-to-video" as const,
    aspectRatio: "9:16" as const,
    durationSec: 5,
  },
};

const promptPlan = {
  schema: "prompt_plan" as const,
  version: 1 as const,
  conceptId: "concept-1",
  momentId: "moment-1",
  shotId: "shot-1",
  imagePrompt: "Gameplay reference image",
  videoPrompt: "Animate only after human approval",
  negativeConstraints: [],
  compilerInputsHash: "0123456789abcdef",
  providerModel: "kling-3",
};

function context(stage: string, repository: Record<string, unknown>): WorkflowTickContext {
  return {
    jobId: "11111111-1111-4111-8111-111111111111",
    workflowKind: "game_discovery_batch",
    workflowVersion: 1,
    currentStage: stage,
    state: {
      creative_run_id: "22222222-2222-4222-8222-222222222222",
      discovery_objective: objective,
    },
    retryCount: 0,
    signal: new AbortController().signal,
    services: {
      gameDiscovery: repository,
    } as unknown as NonNullable<WorkflowTickContext["services"]>,
  };
}

describe("Stage 4 gameplay reference gate", () => {
  it("admits only reference images and keeps video locked", async () => {
    const createReferenceImage = vi.fn(async () => ({
      generationId: "33333333-3333-4333-8333-333333333333",
      factoryJobId: "44444444-4444-4444-8444-444444444444",
      duplicate: false,
    }));
    const result = await gameDiscoveryBatchStage4V1(
      context("reference_image_generation_pending", {
        getVisualStage: async () => ({
          shots: [shot],
          promptPlans: [promptPlan],
          shotPlannerMetadata: {},
          promptCompilerMetadata: {},
          referenceApprovalRequired: true,
        }),
        getReferenceImageStage: async () => ({
          items: [],
          requestCount: 0,
          allTerminal: false,
          allCompleted: false,
        }),
        createReferenceImage,
      }),
    );

    expect(createReferenceImage).toHaveBeenCalledTimes(1);
    expect(createReferenceImage).toHaveBeenCalledWith(
      expect.objectContaining({
        shotId: "shot-1",
        modelId: "nano-banana-2",
        prompt: "Gameplay reference image",
      }),
    );
    expect(result.currentStage).toBe("reference_image_waiting");
    expect(result.state).toMatchObject({ video_generation_locked: true });
  });

  it("moves completed references to a durable human approval wait", async () => {
    const result = await gameDiscoveryBatchStage4V1(
      context("reference_image_waiting", {
        getReferenceImageStage: async () => ({
          requestCount: 1,
          allTerminal: true,
          allCompleted: true,
          items: [
            {
              shotId: "shot-1",
              conceptId: "concept-1",
              momentId: "moment-1",
              conceptRunId: "concept-run-1",
              generationId: "generation-1",
              factoryJobId: "child-job-1",
              status: "completed",
              outputs: [{ url: "https://example.com/reference.png" }],
              errorMessage: null,
              modelId: "nano-banana-2",
            },
          ],
        }),
      }),
    );

    expect(result.currentStage).toBe("human_reference_approval_pending");
    expect(result.nextActionAt).toBeNull();
    expect(result.state).toMatchObject({
      reference_approval_required: true,
      video_generation_locked: true,
    });
  });

  it("unlocks video only for explicitly approved references", async () => {
    const result = await gameDiscoveryBatchStage4V1(
      context("human_reference_approval_pending", {
        getReferenceApprovalStage: async () => ({
          allReviewed: true,
          allApproved: true,
          items: [
            {
              shotId: "shot-1",
              conceptId: "concept-1",
              momentId: "moment-1",
              conceptRunId: "concept-run-1",
              generationId: "generation-1",
              factoryJobId: "child-job-1",
              status: "completed",
              outputs: [{ url: "https://example.com/reference.png" }],
              errorMessage: null,
              modelId: "nano-banana-2",
              decision: "approve",
              reviewId: "review-1",
              rawFeedback: null,
              structuredFeedback: {},
            },
          ],
        }),
      }),
    );

    expect(result.currentStage).toBe("video_generation_pending");
    expect(result.state).toMatchObject({
      human_reference_gate_passed: true,
      video_generation_locked: false,
      approved_reference_generation_ids: ["generation-1"],
    });
  });

  it("keeps video locked when the human requests a revision", async () => {
    const result = await gameDiscoveryBatchStage4V1(
      context("human_reference_approval_pending", {
        getReferenceApprovalStage: async () => ({
          allReviewed: true,
          allApproved: false,
          items: [
            {
              shotId: "shot-1",
              conceptId: "concept-1",
              momentId: "moment-1",
              conceptRunId: "concept-run-1",
              generationId: "generation-1",
              factoryJobId: "child-job-1",
              status: "completed",
              outputs: [{ url: "https://example.com/reference.png" }],
              errorMessage: null,
              modelId: "nano-banana-2",
              decision: "revise",
              reviewId: "review-1",
              rawFeedback: "The dependency is not visible.",
              structuredFeedback: { errorTags: ["coop_dependency_not_visible"] },
            },
          ],
        }),
      }),
    );

    expect(result.currentStage).toBe("reference_revision_pending");
    expect(result.state).toMatchObject({ video_generation_locked: true });
  });
});
