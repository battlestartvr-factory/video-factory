import { describe, expect, it, vi } from "vitest";
import { gameDiscoveryBatchStage4V1 } from "../../worker/workflows/game-discovery-batch-stage4-v1";
import type { WorkflowTickContext } from "../../worker/workflows/types";
import { validGameplayAuthenticityPlan } from "./gameplay-authenticity-fixtures";

const objective = {
  schema: "discovery_objective" as const,
  version: 1 as const,
  objectiveId: "objective-revision",
  title: "Feedback-driven revision",
  searchIntent: "Make the co-op dependency readable in one gameplay frame.",
  playerCount: { min: 2 as const, max: 4 as const },
  platform: "pc_steam" as const,
  desiredNovelty: "balanced" as const,
  conceptCount: 2,
  maxConceptsToPrototype: 1,
  constraints: {},
};

const concept = {
  schema: "coop_game_concept" as const,
  version: 1 as const,
  conceptId: "split-crane",
  oneSentencePitch: "Two operators share control of one dangerous crane load.",
  coreMechanic: "One controls travel and the other cable tension.",
  coopDependency: "Neither can move the load safely alone.",
  playerRoles: [
    { role: "Driver", responsibility: "Move the trolley." },
    { role: "Rigger", responsibility: "Control tension." },
  ],
  playerCount: { min: 2, max: 2, ideal: 2 },
  interactionModel: ["simultaneous asymmetric controls"],
  failureMode: "Cargo hits machinery.",
  socialMoment: "Rigger calls stop while Driver is moving.",
  gameplayHook: "Shared control of one physical object.",
  spectacle: "Cargo narrowly misses a machine.",
  setting: "Industrial bay.",
  artDirection: "Readable stylized industrial game art.",
  camera: "Third-person follow gameplay camera attached to the Driver.",
  readability: "Driver, Rigger and cargo stay visible in playable space.",
  noveltyAxes: [
    { axis: "dependency_type", choice: "split-control", whyDifferent: "Divided controls." },
    { axis: "social_tension", choice: "trust-stop", whyDifferent: "Trust a stop call." },
  ],
  buildability: {
    networking: "low" as const,
    physics: "medium" as const,
    contentBurden: "low" as const,
    npcAiDependency: "none" as const,
    systemicInteractions: "medium" as const,
    mainRisks: ["readability"],
    mvpRead: "One room and one crane.",
  },
  referenceInfluences: [],
};

const moment = {
  schema: "gameplay_moment" as const,
  version: 1 as const,
  momentId: "moment-1",
  conceptId: "split-crane",
  hypothesis: "The divided controls read when the cargo starts swinging.",
  durationTargetSec: 5,
  setup: "Cargo is suspended between two stations.",
  playerActions: [
    { role: "Driver", action: "Moves right.", dependencyOnOthers: "Needs Rigger to damp swing." },
    { role: "Rigger", action: "Tightens cable.", dependencyOnOthers: "Needs Driver to stop." },
  ],
  coopDependencyEvidence: "Both controls must change together.",
  socialTension: "Rigger urgently calls stop.",
  failureBeat: "Cargo clips a machine.",
  expectedViewerUnderstanding: "Two people control different dimensions of one object.",
  cameraIntent: "Third-person follow camera attached to Driver; Rigger and cargo remain in playable distance.",
  requiredVisualEvidence: ["both players visibly operating different controls"],
};

const oldShot = {
  schema: "gameplay_shot" as const,
  version: 1 as const,
  shotId: "old-shot",
  momentId: "moment-1",
  order: 0,
  durationSec: 5,
  purpose: "mechanic" as const,
  actors: ["Driver", "Rigger"],
  action: "Driver controls travel while Rigger changes tension on the same moving cargo.",
  camera: "Third-person follow camera physically attached to Driver.",
  environment: "Industrial bay.",
  continuity: { preserve: [] },
  expectedEvidence: ["both players visibly operating different controls"],
  generationPlan: {
    keyframeRequired: true,
    imageModel: "nano-banana-2" as const,
    videoModel: "kling-3",
    videoMode: "image-to-video" as const,
    aspectRatio: "16:9" as const,
    durationSec: 5,
  },
  metadata: {
    gameplayAuthenticityPlan: validGameplayAuthenticityPlan({
      shotId: "old-shot",
      momentId: "moment-1",
      playerRole: "Driver",
      teammateRole: "Rigger",
      cameraType: "third_person_follow",
    }),
  },
};

const oldPrompt = {
  schema: "prompt_plan" as const,
  version: 1 as const,
  conceptId: "split-crane",
  momentId: "moment-1",
  shotId: "old-shot",
  imagePrompt: "old reference",
  videoPrompt: "old video",
  negativeConstraints: [],
  compilerInputsHash: "0123456789abcdef",
  providerModel: "kling-3",
};

function newShotResponse() {
  const shotId = "revised-shot";
  return JSON.stringify({
    shots: [
      {
        ...oldShot,
        shotId,
        action: "Driver visibly moves the trolley while Rigger visibly operates a separate tension control.",
        metadata: {
          gameplayAuthenticityPlan: validGameplayAuthenticityPlan({
            shotId,
            momentId: "moment-1",
            playerRole: "Driver",
            teammateRole: "Rigger",
            cameraType: "third_person_follow",
          }),
        },
      },
    ],
  });
}

describe("Stage 4 reference revision loop", () => {
  it("replans only the revised shot with stored feedback and returns to reference generation", async () => {
    const prepareReferenceRevision = vi.fn(async () => ({ revisionNumber: 1, duplicate: false }));
    const persistShotsAndPrompts = vi.fn(async () => undefined);
    const llmPrompts: string[] = [];

    const context: WorkflowTickContext = {
      jobId: "11111111-1111-4111-8111-111111111111",
      workflowKind: "game_discovery_batch",
      workflowVersion: 1,
      currentStage: "reference_revision_pending",
      state: {
        creative_run_id: "22222222-2222-4222-8222-222222222222",
        discovery_objective: objective,
        revision_shot_ids: ["old-shot"],
        reference_approvals: [
          {
            shotId: "old-shot",
            generationId: "generation-1",
            reviewId: "review-1",
            decision: "revise",
            structuredFeedback: {
              errorTags: ["coop_dependency_not_visible"],
              mustShow: ["both control stations visible"],
              mustAvoid: ["cinematic close-up"],
            },
          },
        ],
      },
      retryCount: 0,
      signal: new AbortController().signal,
      services: {
        gameDiscovery: {
          getVisualStage: async () => ({
            shots: [oldShot],
            promptPlans: [oldPrompt],
            shotPlannerMetadata: {},
            promptCompilerMetadata: {},
            referenceApprovalRequired: true,
            referenceRevisionNumber: 0,
            lastReferenceRevisionKey: null,
          }),
          getPlanningStage: async () => ({
            preEvaluations: [],
            selectedConceptIds: ["split-crane"],
            moments: [moment],
            preEvaluationMetadata: {},
            momentPlannerMetadata: {},
          }),
          getConceptStage: async () => ({
            persisted: true,
            acceptedConcepts: [concept],
            conceptRuns: [{ runId: "concept-run-1", conceptId: "split-crane" }],
            explorerMetadata: {},
            rejectionCount: 0,
          }),
          getFeedbackMemory: async () => ({
            mustShow: ["both control stations visible"],
            mustAvoid: ["cinematic close-up"],
            errorTags: ["coop_dependency_not_visible"],
          }),
          prepareReferenceRevision,
          persistShotsAndPrompts,
        },
        kieClaude: {
          generate: async (request: { prompt: string }) => {
            llmPrompts.push(request.prompt);
            return {
              text: newShotResponse(),
              usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
              stopReason: "end_turn",
              responsePayload: {},
            };
          },
        },
      } as unknown as NonNullable<WorkflowTickContext["services"]>,
    };

    const result = await gameDiscoveryBatchStage4V1(context);

    expect(prepareReferenceRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        rootCreativeRunId: "22222222-2222-4222-8222-222222222222",
        shotIds: ["old-shot"],
      }),
    );
    expect(llmPrompts).toHaveLength(1);
    expect(llmPrompts[0]).toContain("cinematic close-up");
    expect(llmPrompts[0]).toContain("coop_dependency_not_visible");
    expect(persistShotsAndPrompts).toHaveBeenCalledWith(
      expect.objectContaining({
        promptPlans: [expect.objectContaining({ shotId: "revised-shot" })],
        result: expect.objectContaining({
          shots: [
            expect.objectContaining({
              shotId: "revised-shot",
              metadata: expect.objectContaining({
                gameplayAuthenticity: expect.objectContaining({ passed: true }),
              }),
            }),
          ],
        }),
      }),
    );
    expect(result.currentStage).toBe("reference_image_generation_pending");
    expect(result.state).toMatchObject({
      reference_revision_number: 1,
      revision_shot_ids: ["revised-shot"],
      video_generation_locked: true,
    });
  });
});
