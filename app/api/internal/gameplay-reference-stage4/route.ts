import { NextResponse } from "next/server";
import { verifyIngestBearerToken } from "@/lib/asset-ingest/auth";
import { stage4GameplayReferenceSetSchema } from "@/lib/game-discovery/gameplay-reference-stage4";
import {
  materializeStage4GameplayReferences,
  retrieveStage4GameplayReferences,
} from "@/lib/game-discovery/gameplay-reference-stage4-service";
import {
  coopGameConceptSpecV1Schema,
  gameplayMomentSpecV1Schema,
  shotSpecV1Schema,
} from "@/lib/game-discovery/schemas";
import { resolveExternalVisualReferenceInput } from "@/lib/research-intelligence/external-visual-reference-service";
import { resolveSupabaseServiceRoleKey } from "@/lib/supabase/service-config";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Stage4ReferenceRequest = Record<string, unknown>;

function requiredText(body: Stage4ReferenceRequest, key: string, max = 8_000): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`INVALID_${key.toUpperCase()}`);
  }
  return value.trim();
}

function optionalText(body: Stage4ReferenceRequest, key: string, max = 8_000): string | null {
  const value = body[key];
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`INVALID_${key.toUpperCase()}`);
  }
  return value.trim();
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

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
      const concept = coopGameConceptSpecV1Schema.parse(body.concept);
      const moment = gameplayMomentSpecV1Schema.parse(body.moment);
      const shot = shotSpecV1Schema.parse(body.shot);
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
      const referenceSet = stage4GameplayReferenceSetSchema.parse(body.referenceSet);
      const assets = await materializeStage4GameplayReferences(referenceSet);
      return NextResponse.json(
        { ok: true, data: { assets } },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }

    if (body.action === "admit_reference_image") {
      const referenceSet = stage4GameplayReferenceSetSchema.parse(body.referenceSet);
      const gameplayAssets = await materializeStage4GameplayReferences(referenceSet);
      const modelId = requiredText(body, "modelId", 160);
      const conceptId = requiredText(body, "conceptId", 160);
      const prompt = requiredText(body, "prompt");
      const researchRunId = optionalText(body, "researchRunId", 160);
      const externalVisualQuery = optionalText(body, "externalVisualQuery", 2_000);
      const mustNotCopy = Array.isArray(body.mustNotCopy)
        ? body.mustNotCopy.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 20)
        : [];

      let referenceAssets = gameplayAssets;
      let referenceLineage: unknown[] = [...referenceSet.references];
      let finalPrompt = prompt;
      let externalReferenceCount = 0;
      let externalReferenceWarning: string | null = null;

      if (researchRunId && externalVisualQuery) {
        try {
          const external = await resolveExternalVisualReferenceInput({
            researchRunId,
            conceptId,
            providerModel: modelId,
            existingReferenceCount: gameplayAssets.length,
            query: externalVisualQuery,
            mustNotCopy,
            signal: request.signal,
          });
          if (external) {
            externalReferenceCount = external.referenceAssets.length;
            referenceAssets = [...gameplayAssets, ...external.referenceAssets];
            referenceLineage = [...referenceSet.references, ...external.lineage.references];
            finalPrompt = `${prompt}\n\nSOURCE-GROUNDED EXTERNAL VISUAL REFERENCE INSTRUCTIONS:\n${external.promptInstructionBlock}\n\nREFERENCE FIREWALL: external references are evidence only. Never copy source identity, characters, branding, proprietary UI, exact level layout, or composition verbatim.`;
          }
        } catch (externalError) {
          externalReferenceWarning = externalError instanceof Error ? externalError.message : String(externalError);
          console.warn("stage4_5.external_visual_reference_skipped", {
            research_run_id: researchRunId,
            concept_id: conceptId,
            error: externalReferenceWarning.slice(0, 1_000),
          });
        }
      }

      const supabase = createSupabaseServiceClient();
      const { data, error } = await supabase.rpc("orchestrator_create_gameplay_reference_image", {
        payload: {
          root_job_id: requiredText(body, "rootJobId", 100),
          root_creative_run_id: requiredText(body, "rootCreativeRunId", 100),
          request_id: requiredText(body, "requestId", 100),
          concept_id: conceptId,
          moment_id: requiredText(body, "momentId", 160),
          shot_id: requiredText(body, "shotId", 160),
          prompt: finalPrompt,
          model_id: modelId,
          settings: {
            aspectRatio: "16:9",
            effectiveQuality: "2K",
            stage4_5_external_research_run_id: researchRunId,
            stage4_5_external_reference_count: externalReferenceCount,
            stage4_5_external_reference_warning: externalReferenceWarning,
          },
          reference_assets: referenceAssets,
          reference_lineage: referenceLineage,
        },
      });
      if (error) throw new Error(`REFERENCE_IMAGE_ADMISSION_FAILED:${error.message}`);
      const result = object(data);
      const generation = object(result.generation);
      if (typeof generation.id !== "string" || typeof result.factory_job_id !== "string") {
        throw new Error("REFERENCE_IMAGE_ADMISSION_RESPONSE_INVALID");
      }
      return NextResponse.json(
        {
          ok: true,
          data: {
            generationId: generation.id,
            factoryJobId: result.factory_job_id,
            duplicate: result.duplicate === true,
            referenceCount: referenceAssets.length,
            gameplayReferenceCount: gameplayAssets.length,
            externalReferenceCount,
            externalReferenceWarning,
          },
        },
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
