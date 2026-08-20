import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// CI probe for the final Stage 4 human-controlled generated-media contract.
function source(path: string) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("Stage 4 human media approval contract", () => {
  it("does not let an AI inspector reject generated reference images or gameplay videos", () => {
    const inspected = source("worker/workflows/game-discovery-batch-stage4-inspected-v1.ts");
    const imageGate = source("worker/workflows/gameplay-authenticity-image-stage.ts");

    expect(inspected).not.toContain("inspectGameplayVideosBeforeAssetGraph");
    expect(inspected).not.toContain("gameplay-authenticity-video-stage");
    expect(imageGate).toContain("MAX_AUTOMATIC_IMAGE_AUTHENTICITY_REVISIONS_PER_SHOT = 0");
    expect(imageGate).not.toContain("inspectGameplayImageFromWorker");
  });

  it("parks generated gameplay videos at a human gate with approve, revise and reject", () => {
    const workflow = source("worker/workflows/game-discovery-batch-stage4-video-v1.ts");
    const discoveryUi = source("components/discovery/discovery-page-client.tsx");
    const chatUi = source("components/chat/discovery-task-card.tsx");
    const promptCompiler = source("lib/game-discovery/prompt-compiler.ts");

    expect(workflow).toContain('currentStage: "human_video_approval_pending"');
    expect(workflow).toContain('currentStage: "video_revision_pending"');
    expect(workflow).toContain("getGameplayVideoApprovalStage");
    expect(workflow).toContain("human_requested_regeneration: true");
    expect(workflow).toContain("automatic_video_regeneration: false");
    expect(promptCompiler).toContain("HUMAN FEEDBACK MEMORY — APPLY THIS TO THE REGENERATION");
    expect(promptCompiler).toContain("feedback.mustAvoid");
    expect(promptCompiler).toContain("feedback.mustShow");

    for (const ui of [discoveryUi, chatUi]) {
      expect(ui).toContain("Утвердить");
      expect(ui).toContain("Исправить");
      expect(ui).toContain("Отклонить");
      expect(ui).toContain("video-reviews");
      expect(ui).toContain("human_video_approval_pending");
    }
    expect(discoveryUi).toContain("Ваше решение по gameplay-видео");
    expect(discoveryUi).toContain('media: "video"');
    expect(chatUi).toContain("Gameplay-видео готовы");
    expect(chatUi).toContain("ИИ не может забраковать видео");
  });

  it("stores image and video comments in durable factory feedback memory with decision context", () => {
    const videoGateMigration = source("supabase/migrations/20260820054000_stage4_human_video_review_gate.sql");
    const memoryMigration = source("supabase/migrations/20260820061000_human_review_notes_memory.sql");

    expect(videoGateMigration).toContain("CREATE TABLE IF NOT EXISTS public.gameplay_video_reviews");
    expect(videoGateMigration).toContain("orchestrator_record_gameplay_video_review");
    expect(videoGateMigration).toContain("orchestrator_get_gameplay_video_approval_stage");
    expect(videoGateMigration).toContain("gameplay_video_request_history");

    expect(memoryMigration).toContain("FROM public.gameplay_reference_reviews");
    expect(memoryMigration).toContain("FROM public.gameplay_video_reviews");
    expect(memoryMigration).toContain("'review_note'");
    expect(memoryMigration).toContain("'[reference_image]['");
    expect(memoryMigration).toContain("'[video]['");
  });

  it("counts and finalizes only current human-approved gameplay video branches", () => {
    const finalizationMigration = source("supabase/migrations/20260820062000_finalize_human_approved_videos.sql");

    expect(finalizationMigration).toContain("FROM public.gameplay_video_reviews");
    expect(finalizationMigration).toContain("review.decision = 'approve'");
    expect(finalizationMigration).toContain("humanApprovedVideoCount");
    expect(finalizationMigration).toContain("human-approved video branches without a matching assembly");
  });
});
