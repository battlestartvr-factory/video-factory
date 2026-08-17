import { describe, expect, it } from "vitest";
import { OrchestratorRepository } from "@/lib/orchestrator/repository";
import { PgmqQueueAdapter } from "@/lib/orchestrator/queue/pgmq";
import type { OrchestratorRpcClient } from "@/lib/orchestrator/rpc";
import { coreSmokeV1 } from "@/worker/workflows/core-smoke-v1";
import { getWorkflowHandler, listRegisteredWorkflows } from "@/worker/workflows/registry";

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("core_smoke@1", () => {
  it("persists a checkpoint before completing on the next durable tick", async () => {
    const first = await coreSmokeV1({
      jobId: "job-1",
      workflowKind: "core_smoke",
      workflowVersion: 1,
      currentStage: null,
      state: {},
      retryCount: 0,
      signal: signal(),
    });

    expect(first.status).toBe("queued");
    expect(first.currentStage).toBe("checkpoint_a");
    expect(first.progress).toBe(50);
    expect(first.state?.smoke_step).toBe(1);

    const second = await coreSmokeV1({
      jobId: "job-1",
      workflowKind: "core_smoke",
      workflowVersion: 1,
      currentStage: first.currentStage ?? null,
      state: first.state ?? {},
      retryCount: 0,
      signal: signal(),
    });

    expect(second.status).toBe("completed");
    expect(second.progress).toBe(100);
    expect(second.state?.smoke_step).toBe(2);
    expect(second.result?.ok).toBe(true);
  });

  it("injects one retryable failure when requested", async () => {
    expect(() =>
      coreSmokeV1({
        jobId: "job-retry",
        workflowKind: "core_smoke",
        workflowVersion: 1,
        currentStage: null,
        state: { simulate_retry_once: true },
        retryCount: 0,
        signal: signal(),
      }),
    ).toThrow(
      expect.objectContaining({ code: "CORE_SMOKE_TRANSIENT", retryable: true }),
    );

    const retried = await coreSmokeV1({
      jobId: "job-retry",
      workflowKind: "core_smoke",
      workflowVersion: 1,
      currentStage: null,
      state: { simulate_retry_once: true },
      retryCount: 1,
      signal: signal(),
    });
    expect(retried.status).toBe("queued");
  });

  it("registers workflows by exact kind + version", () => {
    expect(getWorkflowHandler("core_smoke", 1)).toBe(coreSmokeV1);
    expect(getWorkflowHandler("core_smoke", 2)).toBeNull();
    expect(listRegisteredWorkflows()).toContain("core_smoke@1");
  });
});

describe("PgmqQueueAdapter", () => {
  it("maps service-only queue RPC deliveries and archives ACKs", async () => {
    const calls: string[] = [];
    const rpcClient: OrchestratorRpcClient = {
      async rpc(functionName) {
        calls.push(functionName);
        if (functionName === "orchestrator_read_queue") {
          return {
            data: [
              {
                msg_id: 7,
                read_ct: 2,
                enqueued_at: "2026-08-17T15:00:00Z",
                vt: "2026-08-17T15:02:00Z",
                message: {
                  v: 1,
                  job_id: "job-7",
                  reason: "retry",
                  trace_id: "trace-7",
                },
              },
            ],
            error: null,
          };
        }
        return { data: true, error: null };
      },
    };

    const queue = new PgmqQueueAdapter(rpcClient);
    const deliveries = await queue.read();
    expect(deliveries[0]).toMatchObject({
      msgId: 7,
      readCount: 2,
      message: { job_id: "job-7", reason: "retry" },
    });
    await expect(queue.ack(7)).resolves.toBe(true);
    expect(calls).toEqual(["orchestrator_read_queue", "orchestrator_archive_queue_message"]);
  });
});

describe("OrchestratorRepository", () => {
  it("normalizes a claimed job and preserves its fencing token", async () => {
    const rpcClient: OrchestratorRpcClient = {
      async rpc(functionName) {
        expect(functionName).toBe("orchestrator_claim_job");
        return {
          data: {
            claimed: true,
            job_id: "job-1",
            workflow_kind: "core_smoke",
            workflow_version: 1,
            current_stage: null,
            state: { smoke_step: 1 },
            retry_count: 2,
            lease_token: "lease-1",
            lease_expires_at: "2026-08-17T15:02:00Z",
            recovered: true,
          },
          error: null,
        };
      },
    };

    const repository = new OrchestratorRepository(rpcClient);
    await expect(repository.claimJob("job-1", "worker-1")).resolves.toEqual({
      claimed: true,
      jobId: "job-1",
      workflowKind: "core_smoke",
      workflowVersion: 1,
      currentStage: null,
      state: { smoke_step: 1 },
      retryCount: 2,
      leaseToken: "lease-1",
      leaseExpiresAt: "2026-08-17T15:02:00Z",
      recovered: true,
    });
  });
});
