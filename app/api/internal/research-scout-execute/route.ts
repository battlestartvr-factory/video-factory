import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyIngestBearerToken } from "@/lib/asset-ingest/auth";
import type { ResearchScoutProgressEvent } from "@/lib/research-intelligence/progress";
import {
  researchPlanSpecV1Schema,
  researchScoutAssignmentSpecV1Schema,
  researchScoutReportSpecV1Schema,
  researchScoutRoleSchema,
} from "@/lib/research-intelligence/schemas";
import { SharedSourcePoolResearchScoutExecutor } from "@/lib/research-intelligence/shared-source-pool-scout";
import {
  acquireSharedResearchSourcePool,
  sharedResearchSourcePoolV1Schema,
  type SharedResearchSourcePoolV1,
} from "@/lib/research-intelligence/shared-source-pool";
import { resolveSupabaseServiceRoleKey } from "@/lib/supabase/service-config";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const requestSchema = z
  .object({
    jobId: z.string().trim().min(1).max(200),
    context: z
      .object({
        researchRunId: z.string().trim().min(1).max(200),
        scoutRole: researchScoutRoleSchema,
        assignment: researchScoutAssignmentSpecV1Schema,
        creativeRunId: z.string().trim().min(1).max(200),
        rootFactoryJobId: z.string().trim().min(1).max(200),
        rootCreativeRunId: z.string().trim().min(1).max(200),
        objectiveId: z.string().trim().min(1).max(200),
        existingReport: researchScoutReportSpecV1Schema.nullable(),
      })
      .strict(),
  })
  .strict();

const NON_RETRYABLE_PROVIDER_CODES = new Set([
  "WEB_SEARCH_GROUNDING_MISSING",
  "WEB_SEARCH_INVALID_RESPONSE",
  "WEB_SEARCH_NOT_CONFIGURED",
  "RESEARCH_SHARED_SOURCE_POOL_FAILED",
  "RESEARCH_SHARED_SOURCE_POOL_NO_GROUNDED_SOURCES",
  "RESEARCH_SHARED_SOURCE_POOL_NO_SAFE_SOURCES",
  "RESEARCH_SHARED_SOURCE_POOL_COVERAGE_INSUFFICIENT",
  "RESEARCH_SHARED_SOURCE_POOL_PROVIDER_CALL_CAP_EXCEEDED",
  "RESEARCH_SCOUT_NO_GROUNDED_SOURCES",
  "RESEARCH_SCOUT_NO_SAFE_FETCHED_SOURCES",
  "RESEARCH_SCOUT_GROUNDED_CLAIMS_MISSING",
  "RESEARCH_SCOUT_ROLE_ANALYSIS_FAILED",
  "RESEARCH_SCOUT_ROLE_ANALYSIS_INSUFFICIENT",
]);

function statusForExecutionError(code: string): number {
  if (code === "WEB_SEARCH_RATE_LIMITED") return 429;
  if (NON_RETRYABLE_PROVIDER_CODES.has(code)) return 422;
  return 502;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function POST(request: Request) {
  const expectedToken = resolveSupabaseServiceRoleKey();
  if (!verifyIngestBearerToken(request.headers.get("authorization"), expectedToken ?? undefined)) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "INVALID_REQUEST", message: "Invalid Research Scout execution payload" },
      { status: 400 },
    );
  }
  const input = parsed.data;
  if (input.context.assignment.role !== input.context.scoutRole) {
    return NextResponse.json(
      { ok: false, code: "RESEARCH_SCOUT_ROLE_MISMATCH", message: "Scout role and assignment role differ" },
      { status: 400 },
    );
  }
  if (input.context.existingReport) {
    return NextResponse.json(
      {
        ok: false,
        code: "RESEARCH_SCOUT_ALREADY_PERSISTED",
        message: "Paid/tool execution is forbidden when a durable Scout report already exists",
      },
      { status: 409 },
    );
  }

  const executionId = randomUUID();
  const service = createSupabaseServiceClient();
  const reportProgress = async (event: ResearchScoutProgressEvent) => {
    const { error } = await service.rpc("research_record_progress_event", {
      payload: {
        root_factory_job_id: input.context.rootFactoryJobId,
        job_id: input.jobId,
        research_run_id: input.context.researchRunId,
        scout_role: input.context.scoutRole,
        event_type: event.eventType,
        dedupe_key: `scout:${input.jobId}:${executionId}:${event.key}`,
        payload: {
          ...event.payload,
          execution_id: executionId,
        },
      },
    });
    if (!error) return;

    const beforePaidCall =
      event.eventType === "research.scout.started" ||
      event.eventType === "research.search.started" ||
      event.eventType === "research.scout.role_analysis_started";
    if (beforePaidCall) {
      throw new Error(`RESEARCH_PROGRESS_PERSIST_FAILED: ${error.message}`);
    }
    console.warn("research.progress_persist_failed", {
      event_type: event.eventType,
      scout_role: input.context.scoutRole,
      error: error.message.slice(0, 1_000),
    });
  };

  const reportPoolProgress = async (event: { eventType: string; key: string; payload?: Record<string, unknown> }) => {
    const { error } = await service.rpc("research_record_progress_event", {
      payload: {
        root_factory_job_id: input.context.rootFactoryJobId,
        job_id: input.jobId,
        research_run_id: input.context.researchRunId,
        scout_role: null,
        event_type: event.eventType,
        dedupe_key: `source_pool:${input.context.researchRunId}:${executionId}:${event.key}`,
        payload: {
          ...(event.payload ?? {}),
          execution_id: executionId,
          acquisition_owner_job_id: input.jobId,
        },
      },
    });
    if (!error) return;
    if (
      event.eventType === "research.source_pool.search_started" ||
      event.eventType === "research.source_pool.coverage_recovery_started"
    ) {
      throw new Error(`RESEARCH_PROGRESS_PERSIST_FAILED: ${error.message}`);
    }
    console.warn("research.source_pool_progress_persist_failed", {
      event_type: event.eventType,
      error: error.message.slice(0, 1_000),
    });
  };

  async function getPool(): Promise<Record<string, unknown>> {
    const { data, error } = await service.rpc("research_get_shared_source_pool", {
      p_research_run_id: input.context.researchRunId,
    });
    if (error) throw new Error(`Failed to read shared source pool: ${error.message}`);
    return object(data);
  }

  async function waitForReadyPool(): Promise<SharedResearchSourcePoolV1> {
    const deadline = Date.now() + 110_000;
    while (Date.now() < deadline) {
      if (request.signal.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
      const row = await getPool();
      if (row.status === "ready") return sharedResearchSourcePoolV1Schema.parse(row.pool);
      if (row.status === "failed") {
        const errorRow = object(row.error);
        const error = new Error(
          typeof errorRow.message === "string" ? errorRow.message : "Shared research source acquisition failed",
        ) as Error & { code?: string };
        error.code = typeof errorRow.code === "string" ? errorRow.code : "RESEARCH_SHARED_SOURCE_POOL_FAILED";
        throw error;
      }
      await sleep(250, request.signal);
    }
    const error = new Error("Timed out waiting for shared verified source pool") as Error & { code?: string };
    error.code = "RESEARCH_SHARED_SOURCE_POOL_WAIT_TIMEOUT";
    throw error;
  }

  try {
    const leaseResult = await service.rpc("research_acquire_shared_source_pool", {
      payload: {
        research_run_id: input.context.researchRunId,
        job_id: input.jobId,
      },
    });
    if (leaseResult.error) throw new Error(`Failed to acquire shared source pool lease: ${leaseResult.error.message}`);
    const lease = object(leaseResult.data);

    let pool: SharedResearchSourcePoolV1;
    if (lease.status === "ready") {
      pool = sharedResearchSourcePoolV1Schema.parse(lease.pool);
    } else if (lease.acquired === true) {
      const planResult = await service
        .from("research_runs")
        .select("plan")
        .eq("id", input.context.researchRunId)
        .single();
      if (planResult.error) throw new Error(`Failed to load research plan: ${planResult.error.message}`);
      const plan = researchPlanSpecV1Schema.parse(planResult.data?.plan);
      try {
        pool = await acquireSharedResearchSourcePool({
          researchRunId: input.context.researchRunId,
          ownerJobId: input.jobId,
          plan,
          signal: request.signal,
          reportProgress: reportPoolProgress,
        });
        const complete = await service.rpc("research_complete_shared_source_pool", {
          payload: {
            research_run_id: input.context.researchRunId,
            job_id: input.jobId,
            pool,
            usage: pool.usage,
          },
        });
        if (complete.error) throw new Error(`Failed to persist shared source pool: ${complete.error.message}`);
      } catch (error) {
        const value = error as { code?: unknown; message?: unknown; usage?: unknown };
        const code = typeof value.code === "string" ? value.code : "RESEARCH_SHARED_SOURCE_POOL_FAILED";
        const message = typeof value.message === "string" ? value.message : String(error);
        await service.rpc("research_fail_shared_source_pool", {
          payload: {
            research_run_id: input.context.researchRunId,
            job_id: input.jobId,
            error: { code, message: message.slice(0, 2_000) },
            usage: object(value.usage),
          },
        });
        throw error;
      }
    } else if (lease.status === "failed") {
      const errorRow = object(lease.error);
      const error = new Error(
        typeof errorRow.message === "string" ? errorRow.message : "Shared research source acquisition failed",
      ) as Error & { code?: string };
      error.code = typeof errorRow.code === "string" ? errorRow.code : "RESEARCH_SHARED_SOURCE_POOL_FAILED";
      throw error;
    } else {
      pool = await waitForReadyPool();
    }

    const executor = new SharedSourcePoolResearchScoutExecutor(pool, reportProgress);
    const result = await executor.execute({
      jobId: input.jobId,
      context: input.context,
      signal: request.signal,
    });
    return NextResponse.json(
      { ok: true, data: result },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const value = error as { code?: unknown; message?: unknown };
    const code = typeof value?.code === "string" ? value.code : "KIE_RESEARCH_SCOUT_EXECUTION_FAILED";
    const message = typeof value?.message === "string" ? value.message : String(error);
    const status = statusForExecutionError(code);
    console.error("research.kie_scout_execution_failed", {
      code,
      status,
      error: message.slice(0, 2_000),
    });
    return NextResponse.json(
      { ok: false, code, message: message.slice(0, 2_000) },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}