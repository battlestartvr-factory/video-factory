import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyIngestBearerToken } from "@/lib/asset-ingest/auth";
import { resolveSupabaseServiceRoleKey } from "@/lib/supabase/service-config";
import {
  conceptCouncilDesignerRoleSchema,
  conceptHypothesisSpecV1Schema,
} from "@/lib/research-intelligence/concept-council";
import {
  KieProductionConceptCurator,
  KieProductionConceptDesigner,
  KieProductionResearchSynthesizer,
} from "@/lib/research-intelligence/kie-production-intelligence";
import {
  evidencePackSpecV1Schema,
  researchEvidenceSpecV1Schema,
  researchScoutReportSpecV1Schema,
  researchScoutRoleSchema,
} from "@/lib/research-intelligence/schemas";
import { discoveryObjectiveSpecV1Schema } from "@/lib/game-discovery/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const scoutStatusSchema = z.object({
  scoutRole: researchScoutRoleSchema,
  status: z.string().min(1),
  report: researchScoutReportSpecV1Schema.nullable(),
}).strict();

const synthesisInputSchema = z.object({
  researchRunId: z.string().min(1),
  objectiveId: z.string().min(1),
  scoutStatuses: z.array(scoutStatusSchema).max(5),
  evidence: z.array(researchEvidenceSpecV1Schema).max(50),
  knownSourceIds: z.array(z.string().min(1)).max(100),
  knownImageReferenceIds: z.array(z.string().min(1)).max(24),
  activePack: evidencePackSpecV1Schema.nullable(),
}).strict();

const requestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("research_synthesis"),
    synthesisInput: synthesisInputSchema,
  }).strict(),
  z.object({
    operation: z.literal("concept_designer"),
    objective: discoveryObjectiveSpecV1Schema,
    evidencePack: evidencePackSpecV1Schema,
    designerRole: conceptCouncilDesignerRoleSchema,
  }).strict(),
  z.object({
    operation: z.literal("concept_curator"),
    candidates: z.array(conceptHypothesisSpecV1Schema).min(6).max(12),
    evidencePack: evidencePackSpecV1Schema,
    history: z.array(z.unknown()).max(100).optional(),
  }).strict(),
]);

export async function POST(request: Request) {
  const expectedToken = resolveSupabaseServiceRoleKey();
  if (!verifyIngestBearerToken(request.headers.get("authorization"), expectedToken ?? undefined)) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "INVALID_REQUEST", issues: parsed.error.issues.slice(0, 20) },
      { status: 400 },
    );
  }

  try {
    if (parsed.data.operation === "research_synthesis") {
      const result = await new KieProductionResearchSynthesizer().synthesize({
        synthesisInput: parsed.data.synthesisInput,
        signal: request.signal,
      });
      return NextResponse.json({ ok: true, data: result }, { headers: { "Cache-Control": "no-store" } });
    }
    if (parsed.data.operation === "concept_designer") {
      const result = await new KieProductionConceptDesigner().execute({
        objective: parsed.data.objective,
        evidencePack: parsed.data.evidencePack,
        designerRole: parsed.data.designerRole,
        signal: request.signal,
      });
      return NextResponse.json({ ok: true, data: result }, { headers: { "Cache-Control": "no-store" } });
    }

    const result = await new KieProductionConceptCurator().execute({
      candidates: parsed.data.candidates,
      evidencePack: parsed.data.evidencePack,
      signal: request.signal,
    });
    return NextResponse.json({ ok: true, data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = /TIMEOUT|HTTP_429|HTTP_5\d\d|fetch failed|ECONNRESET|ETIMEDOUT/i.test(message);
    console.error("stage4_5.kie_intelligence_failed", {
      operation: parsed.data.operation,
      error: message.slice(0, 1_000),
      retryable,
    });
    return NextResponse.json(
      {
        ok: false,
        code: "KIE_INTELLIGENCE_FAILED",
        message: message.slice(0, 2_000),
        retryable,
      },
      { status: retryable ? 503 : 422, headers: { "Cache-Control": "no-store" } },
    );
  }
}
