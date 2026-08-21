import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260821164000_english_only_generated_media_text.sql"),
  "utf8",
);

describe("generated media visible-text policy", () => {
  it("installs the English-only rule at both paid media admission boundaries", () => {
    expect(migration).toContain("orchestrator_create_gameplay_reference_image(jsonb)");
    expect(migration).toContain("orchestrator_create_approved_gameplay_video(jsonb)");
    expect(migration).toContain("MUST be English only");
    expect(migration).toContain("Never render Russian or Cyrillic text");
  });

  it("advances the deployment schema contract", () => {
    expect(migration).toContain("schema_version = '20260821164000'");
  });
});
