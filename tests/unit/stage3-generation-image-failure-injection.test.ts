import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProviderTaskRepository } from "@/lib/orchestrator/provider-tasks";
import type { OrchestratorRpcClient } from "@/lib/orchestrator/rpc";
import type { GenerationImageRepository } from "@/lib/orchestrator/generation-images";
import type { KieMarketTaskAdapter } from "@/lib/models/kie/market-task";
import { generationImageV1 } from "@/worker/workflows/generation-image-v1";
import type { WorkflowServices } from "@/worker/workflows/types";

const providerLifecycleSql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260817182500_stage3_provider_task_lifecycle.sql"),
  "utf8",
);
const submitPermitSql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260817184000_stage3_provider_submit_permit.sql"),
  "utf8",
);
const atomicFailureSql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260817183600_stage3_image_submit_failure_atomic.sql"),
  "utf8",
);

function prepareInput() {
  return {
    jobId: "job-1",
    workerId: "worker-1",
    leaseToken: "lease-1",
    stage: "provider_image",
    provider: "kie",
    model: "gpt-image-2-text-to-image",
    submissionKey: "generation:gen-1:image:v1:0",
    requestPayload: {
      model: "gpt-image-2-text-to-image",
      input: { prompt: "factory" },
    },
    requestPayloadHash: "hash-1",
  };
}

function successfulWorkflowServices(complete: ReturnType<typeof vi.fn>) {
  const prepare = vi.fn();
  const recordStatus = vi.fn().mockResolvedValue({ status: "succeeded", error: null });
  const submit = vi.fn();
  const getTask = vi.fn().mockResolvedValue({
    taskId: "kie-1",
    model: "gpt-image-2-text-to-image",
    state: "success",
    resultUrls: ["https://example.test/image.png"],
    failCode: null,
    failMessage: null,
    progress: 100,
    creditsConsumed: 1,
    payload: { code: 200, data: { state: "success" } },
  });

  const providerTasks = {
    prepare,
    recordStatus,
  } as unknown as ProviderTaskRepository;
  const generationImages = {
    get: vi.fn().mockResolvedValue({
      id: "gen-1",
      prompt: "factory",
      modelId: "gpt-image-2",
      mode: "text-to-image",
      settings: { aspectRatio: "16:9", numOutputs: 1 },
      referenceAssets: [],
      status: "processing",
    }),
    markProcessing: vi.fn().mockResolvedValue(undefined),
    complete,
    fail: vi.fn().mockResolvedValue(undefined),
  } as unknown as GenerationImageRepository;
  const market = { submit, getTask } as unknown as KieMarketTaskAdapter;

  const services: WorkflowServices = {
    providerTasks,
    generationImages,
    kieMarketTask: market,
    appUrl: "https://factory.example.test",
  };

  return { services, prepare, recordStatus, submit, getTask };
}

function persistedTaskContext(services: WorkflowServices) {
  return {
    jobId: "job-1",
    workflowKind: "generation_image",
    workflowVersion: 1,
    currentStage: "provider_image",
    state: {
      generation_id: "gen-1",
      variant_index: 0,
      outputs: [],
      provider_task_id: "pt-1",
      external_task_id: "kie-1",
    },
    retryCount: 0,
    signal: new AbortController().signal,
    workerId: "worker-1",
    leaseToken: "lease-1",
    services,
  };
}

describe("S3-005 failure injection: provider submit fencing", () => {
  it("recovers a crash after durable prepare but before the paid submit permit", async () => {
    const calls: string[] = [];
    const rpcClient: OrchestratorRpcClient = {
      async rpc(functionName) {
        calls.push(functionName);
        if (functionName === "orchestrator_prepare_provider_task") {
          return {
            data: {
              provider_task_id: "pt-1",
              stage_id: "stage-1",
              status: "queued",
              external_task_id: null,
              callback_token: "token-1",
              submission_attempts: 0,
              should_submit: false,
            },
            error: null,
          };
        }
        if (functionName === "orchestrator_begin_provider_submit") {
          return {
            data: {
              provider_task_id: "pt-1",
              status: "submitting",
              external_task_id: null,
              submission_attempts: 1,
              should_submit: true,
            },
            error: null,
          };
        }
        throw new Error(`unexpected RPC ${functionName}`);
      },
    };

    const repository = new ProviderTaskRepository(rpcClient);
    const prepared = await repository.prepare(prepareInput());

    expect(calls).toEqual([
      "orchestrator_prepare_provider_task",
      "orchestrator_begin_provider_submit",
    ]);
    expect(prepared.status).toBe("submitting");
    expect(prepared.submissionAttempts).toBe(1);
    expect(prepared.shouldSubmit).toBe(true);
  });

  it("never reclaims the paid submit permit after the row reached submitting", async () => {
    const calls: string[] = [];
    const rpcClient: OrchestratorRpcClient = {
      async rpc(functionName) {
        calls.push(functionName);
        return {
          data: {
            provider_task_id: "pt-1",
            stage_id: "stage-1",
            status: "submitting",
            external_task_id: null,
            callback_token: "token-1",
            submission_attempts: 1,
            should_submit: false,
          },
          error: null,
        };
      },
    };

    const repository = new ProviderTaskRepository(rpcClient);
    const prepared = await repository.prepare(prepareInput());

    expect(calls).toEqual(["orchestrator_prepare_provider_task"]);
    expect(prepared.shouldSubmit).toBe(false);
    expect(prepared.submissionAttempts).toBe(1);
  });

  it("implements the permit as a fenced queued -> submitting transition", () => {
    expect(submitPermitSql).toContain("'queued'");
    expect(submitPermitSql).toContain("orchestrator_begin_provider_submit");
    expect(submitPermitSql).toContain("v_task.status = 'queued'");
    expect(submitPermitSql).toContain("status = 'submitting'");
    expect(submitPermitSql).toContain("submission_attempts = submission_attempts + 1");
    expect(submitPermitSql).toContain("active worker lease required for provider submit permit");
    expect(submitPermitSql).toContain("'should_submit', v_should_submit");
    expect(submitPermitSql).toContain("TO service_role");
  });
});

describe("S3-005 failure injection: reconciliation", () => {
  it("does not submit again for a duplicate delivery with a persisted external task id", async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    const setup = successfulWorkflowServices(complete);

    const outcome = await generationImageV1(persistedTaskContext(setup.services));

    expect(outcome.status).toBe("completed");
    expect(setup.prepare).not.toHaveBeenCalled();
    expect(setup.submit).not.toHaveBeenCalled();
    expect(setup.getTask).toHaveBeenCalledOnce();
  });

  it("recovers when recordInfo success persisted but generation completion crashed", async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error("simulated crash before generation completion commit"))
      .mockResolvedValueOnce(undefined);
    const setup = successfulWorkflowServices(complete);
    const tick = persistedTaskContext(setup.services);

    await expect(generationImageV1(tick)).rejects.toThrow("simulated crash");
    const recovered = await generationImageV1(tick);

    expect(recovered.status).toBe("completed");
    expect(setup.submit).not.toHaveBeenCalled();
    expect(setup.recordStatus).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("keeps duplicate callbacks idempotent and callback/poll terminal races monotonic", () => {
    expect(providerLifecycleSql).toContain("'provider:callback:' || v_task.id::TEXT");
    expect(providerLifecycleSql).toContain("ON CONFLICT (dedupe_key) DO NOTHING");
    expect(providerLifecycleSql).toContain(
      "WHEN v_task.status IN ('succeeded', 'failed', 'cancelled') THEN v_task.status",
    );
    expect(providerLifecycleSql).toContain(
      "WHEN status IN ('succeeded', 'failed', 'cancelled') THEN status",
    );
  });

  it("propagates a definitive createTask rejection atomically to the linked generation", () => {
    expect(atomicFailureSql).toContain("orchestrator_record_provider_submit_failure");
    expect(atomicFailureSql).toContain("WHERE g.factory_job_id = v_task.job_id");
    expect(atomicFailureSql).toContain("UPDATE public.generations");
    expect(atomicFailureSql).toContain("UPDATE public.agent_actions");
    expect(atomicFailureSql).toContain("'provider.submit_failed'");
  });
});
