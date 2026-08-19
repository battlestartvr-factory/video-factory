import { NextResponse } from "next/server";
import { verifyIngestBearerToken } from "@/lib/asset-ingest/auth";
import {
  stage4GameplayReferenceSetSchema,
} from "@/lib/game-discovery/gameplay-reference-stage4";
import {
  materializeStage4GameplayReferences,
  retrieveStage4GameplayReferences,
} from "@/lib/game-discovery/gameplay-reference-stage4-service";
import {
  coopGameConceptSpecV1Schema,
  gameplayMomentSpecV1Schema,
  shotSpecV1Schema,
} from "@/lib/game-discovery/schemas";
import { resolveSupabaseServiceRoleKey } from "@/lib/supabase/service-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Stage4ReferenceRequest =
  | {
      action?: unknown;
      concept?: unknown;
      moment?: unknown;
      shot?: unknown;
    }
  | {
      action?: unknown;
      referenceSet?: unknown;
    };

export async function POST(request: Request) {
  const expectedToken = resolveSupabaseServiceRoleKey();
  if (!verifyIngestBearerToken(request.headers.get("authorization"), expectedToken ?? undefined)) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED" }, { status: 401 });
  }

  let body: Stage4ReferenceRequest;
  try {
    body = (await request.json()) as Stage4ReferenceRequest;
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    if (body.action === "retrieve") {
      const concept = coopGameConceptSpecV1Schema.parse("concept" in body ? body.concept : undefined);
      const moment = gameplayMomentSpecV1Schema.parse("moment" in body ? body.moment : undefined);
      const shot = shotSpecV1Schema.parse("shot" in body ? body.shot : undefined);
      if (moment.conceptId !== concept.conceptId || shot.momentId !== moment.momentId) {
        return NextResponse.json(
          { ok: false, code: "REFERENCE_RETRIEVAL_LINEAGE_MISMATCH" },
          { status: 400 },
        );
      }
      const referenceSet = await retrieveStage4GameplayReferences({ concept, moment, shot });
      return NextResponse.json(
        { ok: true, data: { referenceSet } },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }

    if (body.action === "materialize") {
      const referenceSet = stage4GameplayReferenceSetSchema.parse(
        "referenceSet" in body ? body.referenceSet : undefined,
      );
      const assets = await materializeStage4GameplayReferences(referenceSet);
      return NextResponse.json(
        { ok: true, data: { assets } },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json({ ok: false, code: "INVALID_ACTION" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("gameplay_reference.stage4_service_failed", { error: message });
    const code = message.split(":", 1)[0] || "GAMEPLAY_REFERENCE_STAGE4_FAILED";
    const status = code.includes("INSUFFICIENT") ? 409 : code.includes("INVALID") ? 400 : 502;
    return NextResponse.json(
      { ok: false, code, message: message.slice(0, 2_000) },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
