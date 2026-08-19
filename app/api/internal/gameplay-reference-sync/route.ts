import { NextResponse } from "next/server";
import { verifyIngestBearerToken } from "@/lib/asset-ingest/auth";
import { syncGameplayReferenceDrive } from "@/lib/game-discovery/gameplay-reference-drive-sync";
import { resolveSupabaseServiceRoleKey } from "@/lib/supabase/service-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type SyncRequest = {
  maxNewFiles?: unknown;
};

function parseLimit(value: unknown): number | undefined {
  if (value == null) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.trunc(parsed);
}

export async function POST(request: Request) {
  const expectedToken = resolveSupabaseServiceRoleKey();
  if (!verifyIngestBearerToken(request.headers.get("authorization"), expectedToken ?? undefined)) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED" }, { status: 401 });
  }

  let body: SyncRequest = {};
  try {
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text) as SyncRequest;
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = await syncGameplayReferenceDrive({
      maxNewFiles: parseLimit(body.maxNewFiles),
    });
    return NextResponse.json(
      { ok: true, data: result },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("gameplay_reference.drive_sync_failed", { error: message });
    return NextResponse.json(
      {
        ok: false,
        code: message.split(":", 1)[0] || "GAMEPLAY_REFERENCE_DRIVE_SYNC_FAILED",
        message: message.slice(0, 2_000),
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
