import { NextResponse } from "next/server";
import { verifyIngestBearerToken } from "@/lib/asset-ingest/auth";
import { materializeExternalVisualReferences } from "@/lib/research-intelligence/visual-reference-drive";
import { resolveSupabaseServiceRoleKey } from "@/lib/supabase/service-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type MaterializeRequest = {
  researchRunId?: string;
  referenceIds?: string[];
};

export async function POST(request: Request) {
  const expectedToken = resolveSupabaseServiceRoleKey();
  if (!verifyIngestBearerToken(request.headers.get("authorization"), expectedToken ?? undefined)) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED" }, { status: 401 });
  }

  let body: MaterializeRequest;
  try {
    body = (await request.json()) as MaterializeRequest;
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  if (
    typeof body.researchRunId !== "string" ||
    !Array.isArray(body.referenceIds) ||
    body.referenceIds.length < 1 ||
    body.referenceIds.length > 8 ||
    body.referenceIds.some((value) => typeof value !== "string" || !value)
  ) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const assets = await materializeExternalVisualReferences({
      researchRunId: body.researchRunId,
      referenceIds: body.referenceIds,
    });
    return NextResponse.json(
      { ok: true, data: { assets } },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("research.visual_materialize.failed", {
      research_run_id: body.researchRunId,
      reference_ids: body.referenceIds,
      error: message,
    });
    return NextResponse.json(
      { ok: false, code: "MATERIALIZE_FAILED", message },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
