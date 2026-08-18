import { NextResponse } from "next/server";
import { verifyIngestBearerToken } from "@/lib/asset-ingest/auth";
import { archiveDiscoveryAssembly } from "@/lib/game-discovery/assembly-drive-archive";
import { resolveSupabaseServiceRoleKey } from "@/lib/supabase/service-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type AssemblyArchiveRequest = {
  rootCreativeRunId?: string;
  conceptRunId?: string;
  conceptId?: string;
  artifactRelativePath?: string;
  inputVideoGenerationIds?: string[];
  sha256?: string;
  descriptor?: Record<string, unknown>;
};

export async function POST(request: Request) {
  const expectedToken = resolveSupabaseServiceRoleKey();
  if (!verifyIngestBearerToken(request.headers.get("authorization"), expectedToken ?? undefined)) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED" }, { status: 401 });
  }

  let body: AssemblyArchiveRequest;
  try {
    body = (await request.json()) as AssemblyArchiveRequest;
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  if (
    typeof body.rootCreativeRunId !== "string" ||
    typeof body.conceptRunId !== "string" ||
    typeof body.conceptId !== "string" ||
    typeof body.artifactRelativePath !== "string" ||
    !Array.isArray(body.inputVideoGenerationIds) ||
    body.inputVideoGenerationIds.length !== 1 ||
    typeof body.inputVideoGenerationIds[0] !== "string" ||
    !body.inputVideoGenerationIds[0] ||
    typeof body.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(body.sha256)
  ) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const output = await archiveDiscoveryAssembly({
      rootCreativeRunId: body.rootCreativeRunId,
      conceptRunId: body.conceptRunId,
      conceptId: body.conceptId,
      artifactRelativePath: body.artifactRelativePath,
      inputVideoGenerationIds: body.inputVideoGenerationIds,
      sha256: body.sha256,
    });
    return NextResponse.json(
      { ok: true, data: output },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("discovery.assembly.archive_failed", {
      root_creative_run_id: body.rootCreativeRunId,
      concept_run_id: body.conceptRunId,
      error: message,
    });
    const status = message === "GOOGLE_DRIVE_NOT_CONFIGURED" ? 503 : 502;
    return NextResponse.json(
      { ok: false, code: "ASSEMBLY_ARCHIVE_FAILED", message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
