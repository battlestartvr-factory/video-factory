import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260817183500_stage3_generation_image_workflow.sql"),
  "utf8",
);

describe("Stage 3 generation_image@1 migration", () => {
  it("atomically admits the generation, action, durable job, and queue wake", () => {
    expect(sql).toContain("orchestrator_create_image_generation");
    expect(sql).toContain("INSERT INTO public.generations");
    expect(sql).toContain("INSERT INTO public.factory_jobs");
    expect(sql).toContain("'generation_image'");
    expect(sql).toContain("INSERT INTO public.agent_actions");
    expect(sql).toContain("pgmq.send(");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS factory_job_id UUID");
  });

  it("exposes service-only worker transitions for processing, completion, and failure", () => {
    expect(sql).toContain("orchestrator_get_image_generation");
    expect(sql).toContain("orchestrator_mark_image_generation_processing");
    expect(sql).toContain("orchestrator_complete_image_generation");
    expect(sql).toContain("orchestrator_fail_image_generation");
    expect(sql).toContain("orchestrator_record_provider_submit_failure");
    expect(sql.match(/GRANT EXECUTE ON FUNCTION public\.orchestrator_/g)?.length).toBe(6);
    expect(sql.match(/FROM PUBLIC, anon, authenticated/g)?.length).toBe(6);
  });

  it("does not grant an automatic retry after a definitively rejected paid submit", () => {
    expect(sql).toContain("cannot mark submitted provider task as submit failure");
    expect(sql).toContain("'provider.submit_failed'");
    expect(sql).toContain("status = 'failed'");
  });
});
