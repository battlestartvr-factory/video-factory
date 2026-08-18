import { describe, expect, it } from "vitest";
import { parseOrchestratorQueueMessage } from "@/lib/orchestrator/queue/types";

describe("orchestrator queue message contract", () => {
  it("accepts the v1 minimal durable wake message", () => {
    expect(
      parseOrchestratorQueueMessage({
        v: 1,
        job_id: "job-123",
        reason: "retry",
        trace_id: "trace-123",
      }),
    ).toEqual({
      v: 1,
      job_id: "job-123",
      reason: "retry",
      trace_id: "trace-123",
    });
  });

  it("rejects state-bearing or malformed messages that do not satisfy the v1 envelope", () => {
    expect(() => parseOrchestratorQueueMessage(null)).toThrow();
    expect(() =>
      parseOrchestratorQueueMessage({ v: 2, job_id: "job", reason: "manual", trace_id: "trace" }),
    ).toThrow();
    expect(() =>
      parseOrchestratorQueueMessage({ v: 1, reason: "manual", trace_id: "trace" }),
    ).toThrow();
  });
});
