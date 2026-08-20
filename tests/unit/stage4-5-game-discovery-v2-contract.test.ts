import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getWorkflowHandler, listRegisteredWorkflows } from "../../worker/workflows/registry";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260820135500_stage4_5_game_discovery_v2.sql"),
  "utf8",
);
const compatMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260820135600_stage4_5_v1_concept_persist_compat.sql"),
  "utf8",
);
const workflow = readFileSync(
  join(process.cwd(), "worker/workflows/game-discovery-batch-v2.ts"),
  "utf8",
);
const v1Admission = readFileSync(
  join(process.cwd(), "supabase/migrations/20260818090000_stage4_discovery_admission.sql"),
  "utf8",
);

describe("Stage 4.5 PR7 durable v2 contract", () => {
  it("registers v2 beside the unchanged v1 workflow", () => {
    expect(listRegisteredWorkflows()).toContain("game_discovery_batch@1");
    expect(listRegisteredWorkflows()).toContain("game_discovery_batch@2");
    expect(getWorkflowHandler("game_discovery_batch", 1)).not.toBeNull();
    expect(getWorkflowHandler("game_discovery_batch", 2)).not.toBeNull();
  });

  it("admits v2 explicitly at research_planning while v1 admission remains version 1", () => {
    expect(migration).toContain("orchestrator_create_game_discovery_batch_v2");
    expect(migration).toContain("'game_discovery_batch',\n    2,");
    expect(migration).toContain("'research_planning'");
    expect(v1Admission).toContain("'game_discovery_batch',\n    1,");
    expect(v1Admission).toContain("'objective_ready'");
  });

  it("persists exactly six curated grounded cards into the existing Stage 4 concept surface", () => {
    expect(migration).toContain("orchestrator_persist_game_discovery_v2_concepts");
    expect(migration).toContain("jsonb_array_length(v_cards) <> 6");
    expect(migration).toContain("'discovery_concepts', v_concepts");
    expect(migration).toContain("'coop_game_concept', v_concept");
    expect(migration).toContain("'research_context', v_card->'researchContext'");
    expect(migration).toContain("'grounded_game_card', v_card");
    expect(migration).toContain("'research_grounding_by_concept', v_grounding");
  });

  it("reuses the existing Stage 4 wrapper after the v2 research/council states", () => {
    expect(workflow).toContain('currentStage: "human_concept_approval_pending"');
    expect(workflow).toContain('import { gameDiscoveryBatchStage4InspectedV1 }');
    expect(workflow).toContain("return gameDiscoveryBatchStage4InspectedV1(context)");
  });

  it("widens only concept persistence admission for v2 fallback/revision and preserves v1 event idempotency", () => {
    expect(compatMigration).toContain("workflow_version IN (1, 2)");
    expect(compatMigration).toContain("'stage4:s4-003:concepts-persisted'");
    expect(compatMigration).not.toContain("concepts-persisted:' ||");
  });
});
