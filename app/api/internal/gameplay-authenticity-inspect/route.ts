import { NextResponse } from "next/server";
import { verifyIngestBearerToken } from "@/lib/asset-ingest/auth";
import { gameplayAuthenticitySpecV1Schema } from "@/lib/game-discovery/gameplay-authenticity";
import {
  inspectGeneratedGameplayImage,
  inspectGeneratedGameplayVideo,
} from "@/lib/game-discovery/gameplay-authenticity-inspector";
import { resolveSupabaseServiceRoleKey } from "@/lib/supabase/service-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function requiredText(body: Record<string, unknown>, key: string, max = 500): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`INVALID_${key.toUpperCase()}`);
  }
  return value.trim();
}

export async function POST(request: Request) {
  const expectedToken = resolveSupabaseServiceRoleKey();
  if (!verifyIngestBearerToken(request.headers.get("authorization"), expectedToken ?? undefined)) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const common = {
      rootCreativeRunId: requiredText(body, "rootCreativeRunId", 100),
      generationId: requiredText(body, "generationId", 100),
      shotId: requiredText(body, "shotId", 160),
      conceptId: requiredText(body, "conceptId", 160),
      momentId: requiredText(body, "momentId", 160),
      driveFileId: requiredText(body, "driveFileId", 500),
      plannedAuthenticity: gameplayAuthenticitySpecV1Schema.parse(body.plannedAuthenticity),
    };

    if (body.action === "image") {
      const inspection = await inspectGeneratedGameplayImage(common);
      return NextResponse.json(
        { ok: true, data: { inspection } },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }

    if (body.action === "video") {
      const inspection = await inspectGeneratedGameplayVideo(common);
      return NextResponse.json(
        { ok: true, data: { inspection } },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json({ ok: false, code: "INVALID_ACTION" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("gameplay_authenticity.inspection_failed", { error: message });
    const code = message.split(":", 1)[0] || "GAMEPLAY_AUTHENTICITY_INSPECTION_FAILED";
    const status = code.startsWith("INVALID_") ? 400 : 502;
    return NextResponse.json(
      { ok: false, code, message: message.slice(0, 2_000) },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
