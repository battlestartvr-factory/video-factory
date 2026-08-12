import { describe, it, expect } from "vitest";
import {
  createFactoryJobSchema,
  factoryJobActionSchema,
} from "@/lib/factory/validation";

describe("createFactoryJobSchema", () => {
  const base = {
    projectId: "00000000-0000-4000-8000-000000000001",
    jobType: "post" as const,
    preset: "balanced" as const,
    contentNamespace: "dev_reality" as const,
    prompt: "Hello factory",
  };

  it("accepts valid payload", () => {
    const parsed = createFactoryJobSchema.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  it("rejects empty prompt", () => {
    const parsed = createFactoryJobSchema.safeParse({ ...base, prompt: "   " });
    expect(parsed.success).toBe(false);
  });

  it("rejects prompt over 20000 chars", () => {
    const parsed = createFactoryJobSchema.safeParse({
      ...base,
      prompt: "x".repeat(20_001),
    });
    expect(parsed.success).toBe(false);
  });

  it("limits variants to 1..3", () => {
    expect(createFactoryJobSchema.safeParse({ ...base, variants: 0 }).success).toBe(false);
    expect(createFactoryJobSchema.safeParse({ ...base, variants: 4 }).success).toBe(false);
    expect(createFactoryJobSchema.safeParse({ ...base, variants: 2 }).success).toBe(true);
  });

  it("limits duration to 1..60", () => {
    expect(
      createFactoryJobSchema.safeParse({ ...base, durationSeconds: 0 }).success,
    ).toBe(false);
    expect(
      createFactoryJobSchema.safeParse({ ...base, durationSeconds: 61 }).success,
    ).toBe(false);
  });

  it("allows only known aspect ratios", () => {
    expect(
      createFactoryJobSchema.safeParse({ ...base, aspectRatio: "16:9" }).success,
    ).toBe(true);
    expect(
      createFactoryJobSchema.safeParse({ ...base, aspectRatio: "2:3" }).success,
    ).toBe(false);
  });

  it("limits sourceAssetIds to 20", () => {
    const ids = Array.from({ length: 21 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect(createFactoryJobSchema.safeParse({ ...base, sourceAssetIds: ids }).success).toBe(
      false,
    );
  });

  it("rejects prototype pollution keys in metadata", () => {
    const parsed = createFactoryJobSchema.safeParse({
      ...base,
      metadata: { constructor: { prototype: { polluted: true } } },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const parsed = createFactoryJobSchema.safeParse({
      ...base,
      arbitraryUrl: "https://evil.example",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("factoryJobActionSchema", () => {
  it("requires selectedAssetId for approve", () => {
    const parsed = factoryJobActionSchema.safeParse({
      decision: "approve",
      stage: "review",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts regenerate without asset", () => {
    const parsed = factoryJobActionSchema.safeParse({
      decision: "regenerate",
      stage: "review",
      comment: "Try again",
    });
    expect(parsed.success).toBe(true);
  });
});
