import { NextResponse } from "next/server";
import { verifyIngestBearerToken } from "@/lib/asset-ingest/auth";
import { archiveGenerationOutput } from "@/lib/generation/drive-archive";
import { resolveSupabaseServiceRoleKey } from "@/lib/supabase/service-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type ArchiveRequest = {
  generationId?: string;
  outputIndex?: number;
  sourceUrl?: string;
  kind?: "image" | "video";
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
    typeof body.generationId !== "string" ||
    typeof body.outputIndex !== "number" ||
    typeof body.sourceUrl !== "string" ||
    (body.kind !== "image" && body.kind !== "video")
  ) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const output = await archiveGenerationOutput({
      generationId: body.generationId,
      outputIndex: body.outputIndex,
      sourceUrl: body.sourceUrl,
      kind: body.kind,
    });
    return NextResponse.json(
      { ok: true, data: output },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("generation.archive.failed", {
      generation_id: body.generationId,
      output_index: body.outputIndex,
      error: message,
    });
    const status = message === "GOOGLE_DRIVE_NOT_CONFIGURED" ? 503 : 502;
    return NextResponse.json(
      { ok: false, code: "ARCHIVE_FAILED", message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
