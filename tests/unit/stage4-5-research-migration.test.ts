import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260820133000_stage4_5_research_intelligence_contracts.sql",
  ),
  "utf8",
);

const conceptWorkflow = readFileSync(
  join(process.cwd(), "worker/workflows/game-discovery-batch-v1.ts"),
  "utf8",
);
const referenceWorkflow = readFileSync(
  join(process.cwd(), "worker/workflows/game-discovery-batch-stage4-v1.ts"),
  "utf8",
);
const videoWorkflow = readFileSync(
  join(process.cwd(), "worker/workflows/game-discovery-batch-stage4-video-v1.ts"),
  "utf8",
);

describe("Stage 4.5 PR1 Research Memory migration", () => {
  it("is additive and does not mutate the Stage 3/4 orchestration source of truth", () => {
    expect(migration).not.toMatch(/\bDROP TABLE\b/i);
    expect(migration).not.toMatch(/^\s*TRUNCATE\s+/im);
    expect(migration).not.toMatch(/ALTER TABLE public\.factory_jobs/i);
    expect(migration).not.toMatch(/ALTER TABLE public\.creative_runs/i);
    expect(migration).not.toMatch(/pgmq\./i);
  });

  it("creates the bounded evidence/cache layer required by the Stage 4.5 contract", () => {
    for (const table of [
      "research_runs",
      "research_queries",
      "research_sources",
      "research_run_sources",
      "research_evidence",
      "research_evidence_sources",
      "research_assets",
      "research_packs",
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
    }
  });

  it("keeps research linked to the existing durable job and creative lineage owners", () => {
    expect(migration).toMatch(
      /factory_job_id UUID NOT NULL REFERENCES public\.factory_jobs\(id\) ON DELETE CASCADE/,
    );
    expect(migration).toMatch(
      /root_creative_run_id UUID NOT NULL REFERENCES public\.creative_runs\(id\) ON DELETE CASCADE/,
    );
  });

  it("keeps evidence provenance relational and preserves source/cache dedupe primitives", () => {
    expect(migration).toMatch(/url_hash TEXT NOT NULL UNIQUE/);
    expect(migration).toMatch(/idx_research_sources_content_hash/);
    expect(migration).toMatch(/research_evidence_sources/);
    expect(migration).toMatch(/PRIMARY KEY \(evidence_id, source_id\)/);
    expect(migration).toMatch(/idx_research_assets_run_exact_dedupe/);
    expect(migration).toMatch(/idx_research_assets_perceptual_hash/);
  });

  it("allows only one active Evidence Pack per research run", () => {
    expect(migration).toMatch(/idx_research_packs_one_active_per_run/);
    expect(migration).toMatch(/ON public\.research_packs\(run_id\)[\s\S]*WHERE active = TRUE/);
  });

  it("does not silently promote fresh research evidence into Stage 6 durable memory", () => {
    expect(migration).not.toMatch(/memory_items/i);
    expect(migration).toContain("This is not Stage 6 durable strategic memory");
  });

  it("keeps Research Memory service-owned until explicit read surfaces are implemented", () => {
    for (const table of [
      "research_runs",
      "research_queries",
      "research_sources",
      "research_run_sources",
      "research_evidence",
      "research_evidence_sources",
      "research_assets",
      "research_packs",
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated`);
      expect(migration).toContain(`GRANT ALL ON TABLE public.${table} TO service_role`);
    }
  });
});

describe("Stage 4.5 PR1 Human Gate regression boundary", () => {
  it("leaves the concept gate in the existing game_discovery_batch@1 path", () => {
    expect(conceptWorkflow).toContain("game_discovery_batch@1");
    expect(conceptWorkflow).toContain('currentStage: "human_concept_approval_pending"');
    expect(conceptWorkflow).toContain("human_concept_gate_required: true");
  });

  it("leaves the generated reference-image human gate before video admission", () => {
    expect(referenceWorkflow).toContain('"human_reference_approval_pending"');
    expect(videoWorkflow).toContain("human_reference_gate_passed !== true");
    expect(videoWorkflow).toContain("DISCOVERY_VIDEO_HUMAN_GATE_REQUIRED");
  });

  it("leaves gameplay video parked at the final human media gate", () => {
    expect(videoWorkflow).toContain('currentStage: "human_video_approval_pending"');
    expect(videoWorkflow).toContain("automatic_video_regeneration: false");
  });
});
