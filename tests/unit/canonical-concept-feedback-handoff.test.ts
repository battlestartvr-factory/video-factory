import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260821162600_canonical_concept_feedback_handoff.sql"),
  "utf8",
);

describe("canonical concept feedback handoff", () => {
  it("preserves the original human text while giving legacy regeneration canonical English", () => {
    expect(migration).toContain("structured_feedback->>'canonicalEnglish'");
    expect(migration).toContain("'rawFeedback', COALESCE(");
    expect(migration).toContain("'originalRawFeedback', review.raw_feedback");
    expect(migration).toContain("'structuredFeedback', COALESCE(review.structured_feedback");
  });

  it("advances the deployment schema contract", () => {
    expect(migration).toContain("schema_version = '20260821162600'");
  });
});
