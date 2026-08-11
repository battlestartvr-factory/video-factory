import { describe, it, expect } from "vitest";
import { createJobSchema, n8nJobUpdateSchema } from "@/lib/validation/schemas";

describe("createJobSchema", () => {
  it("validates correct payload", () => {
    const result = createJobSchema.safeParse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      type: "short_video",
      mode: "balanced",
      language: "ru",
      targetPlatform: "youtube_shorts",
      brief: "Test brief",
      sourceInput: "https://drive.google.com/file/d/abc123/view",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid project id", () => {
    const result = createJobSchema.safeParse({
      projectId: "not-uuid",
      type: "post",
      mode: "economy",
      language: "ru",
      targetPlatform: "telegram",
      sourceInput: "abc123",
    });
    expect(result.success).toBe(false);
  });
});

describe("n8nJobUpdateSchema", () => {
  it("validates webhook payload", () => {
    const result = n8nJobUpdateSchema.safeParse({
      event: "job.updated",
      eventId: "550e8400-e29b-41d4-a716-446655440001",
      jobId: "550e8400-e29b-41d4-a716-446655440000",
      status: "processing",
      progress: 45,
      stage: "Генерация",
      message: "OK",
      occurredAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });
});
