import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyIngestBearerToken } from "@/lib/asset-ingest/auth";
import { createKieGroundedResearchScoutExecutor } from "@/lib/research-intelligence/kie-research-scout";
import {
  researchScoutAssignmentSpecV1Schema,
  researchScoutReportSpecV1Schema,
  researchScoutRoleSchema,
} from "@/lib/research-intelligence/schemas";
import { resolveSupabaseServiceRoleKey } from "@/lib/supabase/service-config";

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

  try {
    const executor = createKieGroundedResearchScoutExecutor();
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
    const status = code === "WEB_SEARCH_RATE_LIMITED" ? 429 : 502;
    console.error("research.kie_scout_execution_failed", { code, error: message.slice(0, 2_000) });
    return NextResponse.json(
      { ok: false, code, message: message.slice(0, 2_000) },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
