import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const submitHardening = readFileSync(
  join(process.cwd(), "supabase/migrations/20260817183600_stage3_image_submit_failure_atomic.sql"),
  "utf8",
);
const admissionHardening = readFileSync(
  join(process.cwd(), "supabase/migrations/20260817183700_stage3_image_admission_hardening.sql"),
  "utf8",
);

describe("Stage 3 generation image hardening migrations", () => {
  it("fails provider submit + linked generation/action in the same transaction", () => {
    expect(submitHardening).toContain("CREATE OR REPLACE FUNCTION public.orchestrator_record_provider_submit_failure");
    expect(submitHardening).toContain("WHERE g.factory_job_id = v_task.job_id");
    expect(submitHardening).toContain("UPDATE public.generations");
    expect(submitHardening).toContain("UPDATE public.agent_actions");
    expect(submitHardening).toContain("'provider.submit_failed'");
  });

  it("keeps preset identity UUID-typed in the atomic admission RPC", () => {
    expect(admissionHardening).toContain("v_preset_id UUID");
    expect(admissionHardening).toContain("'generation_image'");
    expect(admissionHardening).toContain("pgmq.send(");
    expect(admissionHardening).toContain("TO service_role");
  });
});
