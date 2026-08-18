import { NextResponse } from "next/server";
import { verifyIngestBearerToken } from "@/lib/asset-ingest/auth";
import { archiveGenerationOutput } from "@/lib/generation/drive-archive";
import { resolveSupabaseServiceRoleKey } from "@/lib/supabase/service-config";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { Generation, GenerationOutput } from "@/lib/types/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_GENERATIONS_PER_RUN = 20;

function needsArchive(output: GenerationOutput): boolean {
  return Boolean(output.url) && !(output.storageProvider === "google_drive" && output.driveFileId);
}

export async function POST(request: Request) {
  const expectedToken = resolveSupabaseServiceRoleKey();
  if (!verifyIngestBearerToken(request.headers.get("authorization"), expectedToken ?? undefined)) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED" }, { status: 401 });
  }

  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("generations")
    .select("id,type,outputs,completed_at")
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(MAX_GENERATIONS_PER_RUN);

  if (error) {
    return NextResponse.json({ ok: false, code: "FETCH_FAILED" }, { status: 500 });
  }

  let archivedGenerations = 0;
  let archivedOutputs = 0;
  const failures: Array<{ generationId: string; message: string }> = [];

  for (const row of data ?? []) {
    const generation = row as Pick<Generation, "id" | "type" | "outputs">;
    if (!Array.isArray(generation.outputs) || !generation.outputs.some(needsArchive)) continue;

    try {
      const nextOutputs: GenerationOutput[] = [];
      for (let index = 0; index < generation.outputs.length; index += 1) {
        const output = generation.outputs[index]!;
        if (!needsArchive(output)) {
          nextOutputs.push(output);
          continue;
        }
        const sourceUrl = output.providerUrl ?? output.url;
        if (!sourceUrl) {
          nextOutputs.push(output);
          continue;
        }
        const archived = await archiveGenerationOutput({
          generationId: generation.id,
          outputIndex: index,
          sourceUrl,
          kind: generation.type,
        });
        nextOutputs.push(archived);
        archivedOutputs += 1;
      }

      const { error: updateError } = await service
        .from("generations")
        .update({ outputs: nextOutputs, updated_at: new Date().toISOString() })
        .eq("id", generation.id)
        .eq("status", "completed");
      if (updateError) throw new Error(updateError.message);
      archivedGenerations += 1;
    } catch (archiveError) {
      failures.push({
        generationId: generation.id,
        message: archiveError instanceof Error ? archiveError.message : String(archiveError),
      });
    }
  }

  return NextResponse.json(
    {
      ok: failures.length === 0,
      data: {
        archivedGenerations,
        archivedOutputs,
        failures,
      },
    },
    {
      status: failures.length === 0 ? 200 : 207,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
