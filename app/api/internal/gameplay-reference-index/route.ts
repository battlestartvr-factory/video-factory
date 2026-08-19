import { NextResponse } from "next/server";
import { verifyIngestBearerToken } from "@/lib/asset-ingest/auth";
import {
  isGameplayReferenceCaptionOutputError,
  persistGameplayReferenceCaptionFailureEvidence,
} from "@/lib/game-discovery/gameplay-reference-caption-failure";
import { claimGameplayReferenceCaptionAttempt } from "@/lib/game-discovery/gameplay-reference-caption-permit";
import { indexGameplayReference } from "@/lib/game-discovery/gameplay-reference-service";
import { repairGameplayReferenceFromStoredCaption } from "@/lib/game-discovery/gameplay-reference-stored-repair";
import { resolveSupabaseServiceRoleKey } from "@/lib/supabase/service-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type ReferenceIndexRequest = {
  referenceId?: unknown;
};

export async function POST(request: Request) {
  const expectedToken = resolveSupabaseServiceRoleKey();
  if (!verifyIngestBearerToken(request.headers.get("authorization"), expectedToken ?? undefined)) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED" }, { status: 401 });
  }

  let body: ReferenceIndexRequest;
  try {
    body = (await request.json()) as ReferenceIndexRequest;
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  const referenceId = typeof body.referenceId === "string" ? body.referenceId.trim() : "";
  if (!referenceId || referenceId.length > 160) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    // Cost-control order is deliberate:
    // 1) reuse already-paid raw caption evidence whenever deterministic repair can do so;
    // 2) otherwise atomically consume the single external-call permit;
    // 3) only the permit owner may reach the vision provider.
    //
    // A worker that dies after step 2 leaves the row in `captioning`. Stale-lease recovery will
    // call this route again, but the second permit claim fails closed before another provider call.
    let spec = await repairGameplayReferenceFromStoredCaption(referenceId);
    if (!spec) {
      await claimGameplayReferenceCaptionAttempt(referenceId);
      spec = await indexGameplayReference({ referenceId });
    }

    return NextResponse.json(
      {
        ok: true,
        data: {
          reference_id: spec.referenceId,
          game_name: spec.gameName,
          camera_type: spec.cameraType,
          controllable_player_obvious: spec.controllablePlayerObvious,
          coop_dependency_visible: spec.coopDependencyVisible,
          current_player_action: spec.currentPlayerAction,
          visible_input_affordance: spec.visibleInputAffordance,
          game_response: spec.gameResponse,
          gameplay_description: spec.gameplayDescription,
          why_this_looks_like_gameplay: spec.whyThisLooksLikeGameplay,
          canonical_reference_id: spec.canonicalReferenceId ?? null,
        },
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (isGameplayReferenceCaptionOutputError(error)) {
      await persistGameplayReferenceCaptionFailureEvidence({ referenceId, error }).catch(
        (persistError) => {
          console.error("gameplay_reference.caption_failure_evidence_write_failed", {
            reference_id: referenceId,
            error: persistError instanceof Error ? persistError.message : String(persistError),
          });
        },
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error("gameplay_reference.index_failed", { reference_id: referenceId, error: message });
    const code = isGameplayReferenceCaptionOutputError(error)
      ? error.code
      : message.split(":", 1)[0] || "GAMEPLAY_REFERENCE_INDEX_FAILED";
    const status =
      code === "GAMEPLAY_REFERENCE_NOT_FOUND"
        ? 404
        : code === "GAMEPLAY_REFERENCE_ALREADY_INDEXED" ||
            code === "GAMEPLAY_REFERENCE_CAPTION_PERMIT_DENIED"
          ? 409
          : code.includes("NOT_CONFIGURED") || code.includes("SERVICE_TOKEN_MISSING")
            ? 503
            : 502;
    return NextResponse.json(
      { ok: false, code, message: message.slice(0, 2_000) },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
