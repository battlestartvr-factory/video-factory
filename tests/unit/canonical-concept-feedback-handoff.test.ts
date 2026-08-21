import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260821162600_canonical_concept_feedback_handoff.sql"),
  "utf8",
);
const reviewService = readFileSync(
  join(process.cwd(), "lib/game-discovery/concept-review-service.ts"),
  "utf8",
);
const gate = readFileSync(
  join(process.cwd(), "lib/game-discovery/human-concept-gate.ts"),
  "utf8",
);

describe("canonical concept feedback handoff", () => {
  it("preserves the original human text while giving legacy regeneration canonical English", () => {
    expect(migration).toContain("structured_feedback->>'canonicalEnglish'");
    expect(migration).toContain("'rawFeedback', COALESCE(");
    expect(migration).toContain("'originalRawFeedback', review.raw_feedback");
    expect(migration).toContain("'structuredFeedback', COALESCE(review.structured_feedback");
  });

  it("drops partial rejects but keeps an all-rejected set for one fresh-cycle tick", () => {
    expect(reviewService).toContain('"drop_concept"');
    expect(reviewService).toContain("regenerateOnlyWhenAllActiveConceptsRejected: true");
    expect(migration).toContain("v_rejected_count > 0 AND v_rejected_count < v_active_count");
    expect(migration).toContain("AND review.decision = 'reject'");
    expect(migration).toContain("'accepted_concepts', v_visible_active");
    expect(gate).toContain("const allRejected = input.activeConcepts.length > 0");
    expect(gate).toContain('if (review.decision === "reject")');
    expect(gate).toContain("No paid replacement call is made");
  });

  it("advances the deployment schema contract", () => {
    expect(migration).toContain("schema_version = '20260821162600'");
  });
});
