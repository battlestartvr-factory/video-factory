import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

const v3Migration = read("supabase/migrations/20260821223000_game_discovery_v3_simplified_graph.sql");
const durationMigration = read("supabase/migrations/20260822062000_stage4_gameplay_duration_contract.sql");

describe("Game Discovery v3 database migration contract", () => {
  it("admits workflow version 3 with exactly three concepts and a single research pack", () => {
    expect(v3Migration).toContain("orchestrator_create_game_discovery_batch_v3");
    expect(v3Migration).toContain("'game_discovery_batch',\n    3");
    expect(v3Migration).toContain("conceptCount')::INTEGER, 0) <> 3");
    expect(v3Migration).toContain("maxConceptsToPrototype')::INTEGER, 0) <> 3");
    expect(v3Migration).toContain("orchestrator_persist_game_discovery_v3_research_pack");
    expect(v3Migration).toContain("orchestrator_persist_game_discovery_v3_concepts");
    expect(v3Migration).toContain("jsonb_array_length(v_candidates) <> 3");
    expect(v3Migration).toContain("workflow_version IN (1, 2, 3)");
  });

  it("keeps v1/v2 compatible while making v3 the new explicit path", () => {
    expect(v3Migration).toContain("workflow_version = 3");
    expect(v3Migration).toContain("Game Discovery v3");
    expect(v3Migration).not.toContain("DROP FUNCTION public.orchestrator_create_game_discovery_batch_v2");
    expect(v3Migration).not.toContain("DROP FUNCTION public.orchestrator_create_game_discovery_batch(JSONB)");
  });

  it("passes the persisted ShotSpec duration into Kling and rejects unsupported durations", () => {
    expect(durationMigration).toContain("{gameplay_shot,generationPlan,durationSec}");
    expect(durationMigration).toContain("v_duration_sec NOT IN (5,10,15)");
    expect(durationMigration).toContain("'durationSec',v_duration_sec");
    expect(durationMigration).toContain("'aspectRatio','16:9'");
    expect(durationMigration).toContain("'mode','image-to-video'");
  });

  it("advances the deployment schema fence to the newest migration", () => {
    expect(read("supabase/schema-contract.txt").trim()).toBe("20260822062000");
    expect(durationMigration).toContain("schema_version='20260822062000'");
  });
});