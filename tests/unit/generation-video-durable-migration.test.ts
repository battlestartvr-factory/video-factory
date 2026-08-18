import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const videoWorkflowSql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260818032000_stage3_generation_video_workflow.sql"),
  "utf8",
);
const approvedModelsSql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260818032500_approved_video_models.sql"),
  "utf8",
);
const hardeningSql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260818033000_stage3_video_accounting_and_submit_failure.sql"),
  "utf8",
);

describe("generation_video@1 durable schema", () => {
  it("admits video generations atomically and enqueues the durable workflow", () => {
    expect(videoWorkflowSql).toContain("orchestrator_create_video_generation");
    expect(videoWorkflowSql).toContain("'video'");
    expect(videoWorkflowSql).toContain("'generation_video'");
    expect(videoWorkflowSql).toContain("'provider_video'");
    expect(videoWorkflowSql).toContain("'generate_video'");
    expect(videoWorkflowSql).toContain("pgmq.send");
    expect(videoWorkflowSql).toContain("'core_orchestrator_v1'");
    expect(videoWorkflowSql).toContain("factory_job_id = v_job_id");
  });

  it("keeps video generation transition RPCs service-role only", () => {
    for (const functionName of [
      "orchestrator_create_video_generation",
      "orchestrator_get_video_generation",
      "orchestrator_mark_video_generation_processing",
      "orchestrator_complete_video_generation",
      "orchestrator_fail_video_generation",
    ]) {
      expect(videoWorkflowSql).toContain(functionName);
    }
    expect(videoWorkflowSql).toContain("FROM PUBLIC, anon, authenticated");
    expect(videoWorkflowSql).toContain("TO service_role");
  });
});

describe("generation_video@1 provider catalog", () => {
  it("enables exactly the approved durable video families in the seed", () => {
    expect(approvedModelsSql).toContain("'kling-3'");
    expect(approvedModelsSql).toContain("'veo-3-1'");
    expect(approvedModelsSql).toContain("'seedance-2-5'");
    expect(approvedModelsSql).toContain("'wan-2-7'");
    expect(approvedModelsSql).toContain("'kling-3.0/video'");
    expect(approvedModelsSql).toContain("'bytedance/seedance-2-5'");
    expect(approvedModelsSql).toContain("'wan/2-7-*'");
    expect(approvedModelsSql).toContain("SET enabled = false");
  });
});

describe("generation_video@1 paid-submit and accounting hardening", () => {
  it("propagates definitive submit rejection atomically to image or video generation", () => {
    expect(hardeningSql).toContain("orchestrator_record_provider_submit_failure");
    expect(hardeningSql).toContain("g.type IN ('image', 'video')");
    expect(hardeningSql).toContain("WHEN v_generation_type = 'video' THEN 'generate_video'");
    expect(hardeningSql).toContain("'generation:' || v_generation_type || ':failed:'");
  });

  it("preserves the paid-submit accounting gate for both media workflows", () => {
    expect(hardeningSql).toContain("v_workflow_kind NOT IN ('generation_image', 'generation_video')");
    expect(hardeningSql).toContain("WHEN v_workflow_kind = 'generation_video' THEN 'video'");
    expect(hardeningSql).toContain("v_submit_started := NEW.submission_attempts > 0");
    expect(hardeningSql).toContain("prepared_not_submitted_zero");
    expect(hardeningSql).toContain("submission_attempts,");
    expect(hardeningSql).toContain("unknown_zero_placeholder");
  });
});
