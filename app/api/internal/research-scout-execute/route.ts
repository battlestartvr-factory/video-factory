import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyIngestBearerToken } from "@/lib/asset-ingest/auth";
import { createKieGroundedResearchScoutExecutor } from "@/lib/research-intelligence/kie-research-scout";
import type { ResearchScoutProgressEvent } from "@/lib/research-intelligence/progress";
import {
  researchScoutAssignmentSpecV1Schema,
  researchScoutReportSpecV1Schema,
  researchScoutRoleSchema,
} from "@/lib/research-intelligence/schemas";
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
  "RESEARCH_SCOUT_NO_GROUNDED_SOURCES",
  "RESEARCH_SCOUT_NO_SAFE_FETCHED_SOURCES",
  "RESEARCH_SCOUT_GROUNDED_CLAIMS_MISSING",
]);

function statusForExecutionError(code: string): number {
  if (code === "WEB_SEARCH_RATE_LIMITED") return 429;
  if (NON_RETRYABLE_PROVIDER_CODES.has(code)) return 422;
  return 502;
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
  if (parsed.data.context.assignment.role !== parsed.data.context.scoutRole) {
    return NextResponse.json(
      { ok: false, code: "RESEARCH_SCOUT_ROLE_MISMATCH", message: "Scout role and assignment role differ" },
      { status: 400 },
    );
  }
  if (parsed.data.context.existingReport) {
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
        root_factory_job_id: parsed.data.context.rootFactoryJobId,
        job_id: parsed.data.jobId,
        research_run_id: parsed.data.context.researchRunId,
        scout_role: parsed.data.context.scoutRole,
        event_type: event.eventType,
        dedupe_key: `scout:${parsed.data.jobId}:${executionId}:${event.key}`,
        payload: {
          ...event.payload,
          execution_id: executionId,
        },
      },
    });
    if (!error) return;

    const beforePaidCall =
      event.eventType === "research.scout.started" ||
      event.eventType === "research.search.started";
    if (beforePaidCall) {
      throw new Error(`RESEARCH_PROGRESS_PERSIST_FAILED: ${error.message}`);
    }
    console.warn("research.progress_persist_failed", {
      event_type: event.eventType,
      scout_role: parsed.data.context.scoutRole,
      error: error.message.slice(0, 1_000),
    });
  };

  try {
    const executor = createKieGroundedResearchScoutExecutor(reportProgress);
    const result = await executor.execute({
      jobId: parsed.data.jobId,
      context: parsed.data.context,
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
