import { NextResponse } from "next/server";
import { verifyIngestBearerToken } from "@/lib/asset-ingest/auth";
import { archiveExternalVisualReference } from "@/lib/research-intelligence/visual-reference-drive";
import { resolveSupabaseServiceRoleKey } from "@/lib/supabase/service-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type ArchiveRequest = {
  researchRunId?: string;
  referenceId?: string;
  sourceUrl?: string;
  imageUrl?: string;
  expectedSha256?: string;
  expectedMimeType?: string;
  expectedWidth?: number;
  expectedHeight?: number;
};

export async function POST(request: Request) {
  const expectedToken = resolveSupabaseServiceRoleKey();
  if (!verifyIngestBearerToken(request.headers.get("authorization"), expectedToken ?? undefined)) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED" }, { status: 401 });
  }

  let body: ArchiveRequest;
  try {
    body = (await request.json()) as ArchiveRequest;
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  if (
    typeof body.researchRunId !== "string" ||
    typeof body.referenceId !== "string" ||
    typeof body.sourceUrl !== "string" ||
    typeof body.imageUrl !== "string" ||
    typeof body.expectedSha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(body.expectedSha256)
  ) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const output = await archiveExternalVisualReference({
      researchRunId: body.researchRunId,
      referenceId: body.referenceId,
      imageUrl: body.imageUrl,
      expectedSha256: body.expectedSha256,
      expectedMimeType: body.expectedMimeType,
      expectedWidth: body.expectedWidth,
      expectedHeight: body.expectedHeight,
    });
    return NextResponse.json(
      { ok: true, data: output },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("research.visual_archive.failed", {
      research_run_id: body.researchRunId,
      reference_id: body.referenceId,
      source_url: body.sourceUrl,
      error: message,
    });
    const status = message === "GOOGLE_DRIVE_NOT_CONFIGURED" ? 503 : 502;
    return NextResponse.json(
      { ok: false, code: "ARCHIVE_FAILED", message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
