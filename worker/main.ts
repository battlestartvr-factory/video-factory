import { setTimeout as sleep } from "node:timers/promises";
import { GameDiscoveryWorkerRepository } from "../lib/game-discovery/worker-repository";
import { GenerationImageRepository } from "../lib/orchestrator/generation-images";
import { GenerationVideoRepository } from "../lib/orchestrator/generation-videos";
import { ProviderTaskRepository } from "../lib/orchestrator/provider-tasks";
import { OrchestratorRepository, type ClaimedJob } from "../lib/orchestrator/repository";
import { PgmqQueueAdapter } from "../lib/orchestrator/queue/pgmq";
import type { QueueDelivery } from "../lib/orchestrator/queue/types";
import {
  computeRetryDelayMs,
  normalizeWorkflowError,
  shouldRetry,
} from "../lib/orchestrator/retry";
import { KieClaudeTaskAdapter } from "../lib/models/kie/claude-task";
import { KieMarketTaskAdapter } from "../lib/models/kie/market-task";
import { KieVeoTaskAdapter } from "../lib/models/kie/veo-task";
import { loadWorkerConfig, type WorkerConfig } from "./config";
import { workerLog } from "./log";
import { createWorkerRpcClient } from "./rpc-client";
import { getWorkflowHandler, listRegisteredWorkflows } from "./workflows/registry";
import type { WorkflowServices, WorkflowTickOutcome } from "./workflows/types";

function errorPayload(error: unknown): Record<string, unknown> {
  const normalized = normalizeWorkflowError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
    ...(normalized.retryAfterMs !== undefined ? { retry_after_ms: normalized.retryAfterMs } : {}),
    ...(normalized.details ? { details: normalized.details } : {}),
  };
}

function failureOutcome(
  error: unknown,
  claimed: ClaimedJob,
  config: WorkerConfig,
): WorkflowTickOutcome {
  const normalized = normalizeWorkflowError(error);
  const payload = errorPayload(error);

  if (
    shouldRetry({
      retryable: normalized.retryable,
      retryCount: claimed.retryCount,
      maxAttempts: config.maxAttempts,
    })
  ) {
    const delayMs = computeRetryDelayMs({
      retryCount: claimed.retryCount,
      retryAfterMs: normalized.retryAfterMs,
    });
    const nextActionAt = new Date(Date.now() + delayMs).toISOString();
    return {
      status: "retrying",
      state: claimed.state,
      currentStage: claimed.currentStage,
      nextActionAt,
      error: payload,
      stateReason: `retry_scheduled:${normalized.code}`,
      eventType: "retry.scheduled",
      eventPayload: {
        error: payload,
        retry_count: claimed.retryCount + 1,
        max_attempts: config.maxAttempts,
        delay_ms: delayMs,
        next_action_at: nextActionAt,
      },
      enqueueReason: "retry",
    };
  }

  return {
    status: "failed",
    state: claimed.state,
    currentStage: claimed.currentStage,
    error: payload,
    stateReason: normalized.retryable ? "retry_exhausted" : "terminal_error",
    eventType: "job.failed",
    eventPayload: {
      error: payload,
      retry_count: claimed.retryCount,
      max_attempts: config.maxAttempts,
    },
  };
}

async function safeAck(
  queue: PgmqQueueAdapter,
  delivery: QueueDelivery,
  fields: Record<string, unknown>,
): Promise<void> {
  try {
    const archived = await queue.ack(delivery.msgId);
    workerLog(archived ? "info" : "warn", "orchestrator.queue.ack", {
      ...fields,
      queue_msg_id: delivery.msgId,
      archived,
    });
  } catch (error) {
    workerLog("error", "orchestrator.queue.ack_failed", {
      ...fields,
      queue_msg_id: delivery.msgId,
      error: errorPayload(error),
    });
  }
}

async function processClaimedDelivery(input: {
  delivery: QueueDelivery;
  claimed: ClaimedJob;
  repository: OrchestratorRepository;
  queue: PgmqQueueAdapter;
  services: WorkflowServices;
  config: WorkerConfig;
  setActiveAbort: (controller: AbortController | null) => void;
  isStopping: () => boolean;
}): Promise<void> {
  const { delivery, claimed, repository, queue, services, config } = input;
  const fields = {
    worker_id: config.workerId,
    job_id: claimed.jobId,
    workflow_kind: claimed.workflowKind,
    workflow_version: claimed.workflowVersion,
    retry_count: claimed.retryCount,
    queue_msg_id: delivery.msgId,
    queue_read_count: delivery.readCount,
    trace_id: delivery.message.trace_id,
    recovered: claimed.recovered,
  };

  const controller = new AbortController();
  input.setActiveAbort(controller);
  let leaseLost = false;
  let heartbeatInFlight = false;

  const heartbeat = async () => {
    if (heartbeatInFlight || leaseLost || controller.signal.aborted) return;
    heartbeatInFlight = true;
    try {
      const result = await repository.heartbeatJob({
        jobId: claimed.jobId,
        workerId: config.workerId,
        leaseToken: claimed.leaseToken,
        msgId: delivery.msgId,
        leaseSeconds: config.leaseSeconds,
        visibilitySeconds: config.visibilitySeconds,
      });
      if (!result.renewed) {
        leaseLost = true;
        controller.abort(new Error(result.reason ?? "lease_not_renewed"));
        workerLog("warn", "orchestrator.job.lease_lost", { ...fields, reason: result.reason });
      }
    } catch (error) {
      leaseLost = true;
      controller.abort(error instanceof Error ? error : new Error(String(error)));
      workerLog("error", "orchestrator.job.heartbeat_failed", {
        ...fields,
        error: errorPayload(error),
      });
    } finally {
      heartbeatInFlight = false;
    }
  };

  const heartbeatTimer = setInterval(() => void heartbeat(), config.leaseHeartbeatMs);

  try {
    const handler = getWorkflowHandler(claimed.workflowKind, claimed.workflowVersion);
    let outcome: WorkflowTickOutcome;

    if (!handler) {
      outcome = {
        status: "failed",
        state: claimed.state,
        currentStage: claimed.currentStage,
        error: {
          code: "WORKFLOW_NOT_REGISTERED",
          message: `No handler for ${claimed.workflowKind}@${claimed.workflowVersion}`,
          retryable: false,
        },
        stateReason: "workflow_not_registered",
        eventType: "job.failed",
      };
    } else {
      try {
        outcome = await handler({
          jobId: claimed.jobId,
          workflowKind: claimed.workflowKind,
          workflowVersion: claimed.workflowVersion,
          currentStage: claimed.currentStage,
          state: claimed.state,
          retryCount: claimed.retryCount,
          signal: controller.signal,
          workerId: config.workerId,
          leaseToken: claimed.leaseToken,
          services,
        });
      } catch (error) {
        if (controller.signal.aborted || input.isStopping()) {
          workerLog("warn", "orchestrator.job.tick_abandoned", {
            ...fields,
            reason: "shutdown_or_lease_loss",
          });
          return;
        }
        outcome = failureOutcome(error, claimed, config);
      }
    }

    if (leaseLost || controller.signal.aborted || input.isStopping()) {
      workerLog("warn", "orchestrator.job.commit_skipped", {
        ...fields,
        reason: leaseLost ? "lease_lost" : "shutdown",
      });
      return;
    }

    const finished = await repository.finishTick({
      jobId: claimed.jobId,
      workerId: config.workerId,
      leaseToken: claimed.leaseToken,
      newStatus: outcome.status,
      state: outcome.state,
      currentStage: outcome.currentStage,
      progress: outcome.progress,
      nextActionAt: outcome.nextActionAt,
      result: outcome.result,
      error: outcome.error,
      stateReason: outcome.stateReason,
      eventType: outcome.eventType,
      eventPayload: {
        ...(outcome.eventPayload ?? {}),
        trace_id: delivery.message.trace_id,
      },
      enqueueReason: outcome.enqueueReason,
      traceId: delivery.message.trace_id,
    });

    if (!finished.success) {
      workerLog("warn", "orchestrator.job.commit_rejected", {
        ...fields,
        reason: finished.reason,
      });
      return;
    }

    workerLog("info", "orchestrator.job.tick_committed", {
      ...fields,
      status: outcome.status,
      persisted_retry_count: finished.retryCount,
      next_action_at: finished.nextActionAt,
      next_queue_msg_id: finished.queueMsgId,
    });
    await safeAck(queue, delivery, fields);
  } finally {
    clearInterval(heartbeatTimer);
    input.setActiveAbort(null);
  }
}

export async function runWorker(): Promise<void> {
  const config = loadWorkerConfig();
  const rpcClient = createWorkerRpcClient(config.supabaseUrl, config.serviceRoleKey);
  const repository = new OrchestratorRepository(rpcClient);
  const queue = new PgmqQueueAdapter(rpcClient);
  const services: WorkflowServices = {
    providerTasks: new ProviderTaskRepository(rpcClient),
    generationImages: new GenerationImageRepository(rpcClient),
    generationVideos: new GenerationVideoRepository(rpcClient),
    gameDiscovery: new GameDiscoveryWorkerRepository(rpcClient),
    kieClaude: config.kieApiKey
      ? new KieClaudeTaskAdapter(config.kieApiBaseUrl, config.kieApiKey)
      : null,
    kieMarketTask: config.kieApiKey
      ? new KieMarketTaskAdapter(config.kieApiBaseUrl, config.kieApiKey)
      : null,
    kieVeoTask: config.kieApiKey
      ? new KieVeoTaskAdapter(config.kieApiBaseUrl, config.kieApiKey)
      : null,
    appUrl: config.appUrl,
  };
  let stopping = false;
  let activeAbort: AbortController | null = null;
  let watchdogInFlight = false;

  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    workerLog("warn", "orchestrator.worker.stopping", {
      worker_id: config.workerId,
      signal,
    });
    activeAbort?.abort(new Error(`worker shutdown: ${signal}`));
  };

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  await repository.heartbeatWorker({
    workerId: config.workerId,
    buildSha: config.buildSha,
    metadata: { workflows: listRegisteredWorkflows(), pid: process.pid },
  });

  const workerHeartbeatTimer = setInterval(() => {
    void repository
      .heartbeatWorker({
        workerId: config.workerId,
        buildSha: config.buildSha,
        metadata: { workflows: listRegisteredWorkflows(), pid: process.pid },
      })
      .catch((error) =>
        workerLog("error", "orchestrator.worker.heartbeat_failed", {
          worker_id: config.workerId,
          error: errorPayload(error),
        }),
      );
  }, config.workerHeartbeatMs);

  const runWatchdog = async () => {
    if (watchdogInFlight || stopping) return;
    watchdogInFlight = true;
    try {
      const result = await repository.recoverDueJobs();
      if (result.recovered > 0 || result.staleLeases > 0) {
        workerLog("warn", "orchestrator.watchdog.recovered", {
          worker_id: config.workerId,
          recovered: result.recovered,
          stale_leases: result.staleLeases,
        });
      }
    } catch (error) {
      workerLog("error", "orchestrator.watchdog.failed", {
        worker_id: config.workerId,
        error: errorPayload(error),
      });
    } finally {
      watchdogInFlight = false;
    }
  };

  await runWatchdog();
  const watchdogTimer = setInterval(() => void runWatchdog(), config.watchdogMs);

  workerLog("info", "orchestrator.worker.started", {
    worker_id: config.workerId,
    build_sha: config.buildSha,
    workflows: listRegisteredWorkflows(),
    lease_seconds: config.leaseSeconds,
    visibility_seconds: config.visibilitySeconds,
    watchdog_ms: config.watchdogMs,
    max_attempts: config.maxAttempts,
  });

  try {
    while (!stopping) {
      let deliveries: QueueDelivery[];
      try {
        deliveries = await queue.read({
          visibilitySeconds: config.visibilitySeconds,
          quantity: 1,
        });
      } catch (error) {
        workerLog("error", "orchestrator.queue.read_failed", {
          worker_id: config.workerId,
          error: errorPayload(error),
        });
        await sleep(Math.max(config.queuePollMs, 2000));
        continue;
      }

      if (!deliveries.length) {
        await sleep(config.queuePollMs);
        continue;
      }

      for (const delivery of deliveries) {
        if (stopping) break;
        const baseFields = {
          worker_id: config.workerId,
          job_id: delivery.message.job_id,
          queue_msg_id: delivery.msgId,
          queue_read_count: delivery.readCount,
          trace_id: delivery.message.trace_id,
          reason: delivery.message.reason,
        };

        let claim;
        try {
          claim = await repository.claimJob(
            delivery.message.job_id,
            config.workerId,
            config.leaseSeconds,
          );
        } catch (error) {
          workerLog("error", "orchestrator.job.claim_failed", {
            ...baseFields,
            error: errorPayload(error),
          });
          continue;
        }

        if (!claim.claimed) {
          workerLog("info", "orchestrator.job.delivery_skipped", {
            ...baseFields,
            reason: claim.reason,
            status: claim.status,
          });
          await safeAck(queue, delivery, baseFields);
          continue;
        }

        await processClaimedDelivery({
          delivery,
          claimed: claim,
          repository,
          queue,
          services,
          config,
          setActiveAbort: (controller) => {
            activeAbort = controller;
          },
          isStopping: () => stopping,
        });
      }
    }
  } finally {
    clearInterval(workerHeartbeatTimer);
    clearInterval(watchdogTimer);
    workerLog("info", "orchestrator.worker.stopped", { worker_id: config.workerId });
  }
}

void runWorker().catch((error) => {
  workerLog("error", "orchestrator.worker.fatal", { error: errorPayload(error) });
  process.exitCode = 1;
});
