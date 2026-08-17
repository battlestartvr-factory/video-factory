import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260817184800_stage3_pricing_evidence.sql"),
  "utf8",
);

describe("Stage 3 KIE pricing evidence", () => {
  it("does not guess a price tier when resolution is absent", () => {
    expect(sql).toContain("resolution_unspecified_no_price_estimate");
    expect(sql).toContain("v_resolution := upper(NULLIF");
  });

  it("keeps explicit list-price estimates resolution-specific", () => {
    expect(sql).toContain("WHEN '1K' THEN 0.030000");
    expect(sql).toContain("WHEN '2K' THEN 0.050000");
    expect(sql).toContain("WHEN '4K' THEN 0.080000");
    expect(sql).toContain("WHEN '1K' THEN 0.040000");
    expect(sql).toContain("WHEN '2K' THEN 0.060000");
    expect(sql).toContain("WHEN '4K' THEN 0.090000");
  });

  it("propagates evidence basis into the deduped cost event", () => {
    expect(sql).toContain("NEW.pricing_snapshot ->> 'basis'");
    expect(sql).toContain("'provider:cost:' || NEW.id::TEXT");
  });
});
