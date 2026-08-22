import { getSessionUser } from "@/lib/auth/session";
import { apiError, apiSuccess } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import { getGameDiscoveryBatch } from "@/lib/game-discovery/service";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

function compactObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function compactConcept(spec: unknown) {
  const row = compactObject(spec);
  const concept = compactObject(row.concept);
  return {
    candidateId: typeof row.candidateId === "string" ? row.candidateId : null,
    designerRole: typeof row.designerRole === "string" ? row.designerRole : null,
    researchConfidence: typeof row.researchConfidence === "number" ? row.researchConfidence : null,
    supportingEvidenceIds: Array.isArray(row.supportingEvidenceIds) ? row.supportingEvidenceIds : [],
    whatIsNew: typeof row.whatIsNew === "string" ? row.whatIsNew : null,
    concept: {
      conceptId: typeof concept.conceptId === "string" ? concept.conceptId : null,
      oneSentencePitch: typeof concept.oneSentencePitch === "string" ? concept.oneSentencePitch : null,
      coreMechanic: typeof concept.coreMechanic === "string" ? concept.coreMechanic : null,
      coopDependency: typeof concept.coopDependency === "string" ? concept.coopDependency : null,
      setting: typeof concept.setting === "string" ? concept.setting : null,
    },
  };
}

function v3PackSources(pack: Record<string, unknown>) {
  if (pack.schema !== "game_discovery_research_pack" || pack.version !== 1 || !Array.isArray(pack.sources)) {
    return [];
  }
  return pack.sources.flatMap((raw, index) => {
    const source = compactObject(raw);
    const url = typeof source.canonicalUrl === "string" ? source.canonicalUrl : null;
    if (!url) return [];
    return [{
      id: typeof source.sourceRef === "string" ? source.sourceRef : `v3-source-${index}`,
      title: typeof source.title === "string" ? source.title : null,
      url,
      sourceType: "verified_web_source",
      publishedAt: null,
      observedAt: typeof source.observedAt === "string" ? source.observedAt : null,
      scoutRole: null,
      relevanceScore: null,
      selected: true,
      reusedFromCache: false,
      categories: Array.isArray(source.categories) ? source.categories : [],
      groundedClaims: Array.isArray(source.groundedClaims) ? source.groundedClaims : [],
    }];
  });
}

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);
  const { runId } = await context.params;

  let root;
  try {
    root = await getGameDiscoveryBatch({ userId: user.id, runId });
    if (!root) return apiError("NOT_FOUND", "Запуск не найден", 404, requestId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    if (message === "FORBIDDEN") return apiError("FORBIDDEN", "Нет доступа к запуску", 403, requestId);
    return apiError("NOT_FOUND", "Запуск не найден", 404, requestId);
  }

  const rootOutputs = compactObject(root.outputs);
  const candidateV3Pack = compactObject(rootOutputs.research_pack);
  const researchPack =
    candidateV3Pack.schema === "game_discovery_research_pack" && candidateV3Pack.version === 1
      ? candidateV3Pack
      : null;
  const simplifiedSources = researchPack ? v3PackSources(researchPack) : [];

  const service = createSupabaseServiceClient();
  const { data: researchRun, error: runError } = await service
    .from("research_runs")
    .select("id,status,objective_id,plan,budget,coverage,cost,error,metadata,started_at,completed_at,created_at,updated_at")
    .eq("root_creative_run_id", runId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (runError) {
    return apiError("RESEARCH_OBSERVABILITY_FAILED", "Не удалось загрузить исследование", 500, requestId);
  }
  if (!researchRun) {
    return apiSuccess({
      researchRun: null,
      researchPack,
      scouts: [],
      sources: simplifiedSources,
      evidence: [],
      evidencePack: null,
      conceptDesigners: [],
      rawCandidates: [],
      curation: null,
      externalVisualReferences: [],
      imageReferenceSets: [],
    });
  }

  const researchRunId = researchRun.id;
  const [scoutAssignments, runSources, evidenceResult, packResult, designerAssignments, candidatesResult, curationResult, assetsResult, referenceSetsResult] = await Promise.all([
    service.from("research_scout_assignments").select("scout_role,factory_job_id,creative_run_id,assignment,metadata,created_at").eq("run_id", researchRunId).order("scout_role"),
    service.from("research_run_sources").select("source_id,scout_role,relevance_score,selected,reused_from_cache,metadata,created_at").eq("run_id", researchRunId).order("created_at"),
    service.from("research_evidence").select("id,scout_role,evidence_type,subject,claim,confidence,freshness_class,tags,observed_at,metadata,created_at").eq("run_id", researchRunId).order("confidence", { ascending: false }).limit(50),
    service.from("research_packs").select("id,pack,active,generated_at,metadata").eq("run_id", researchRunId).eq("active", true).order("generated_at", { ascending: false }).limit(1).maybeSingle(),
    service.from("concept_council_assignments").select("designer_role,factory_job_id,creative_run_id,metadata,created_at").eq("run_id", researchRunId).order("designer_role"),
    service.from("concept_candidates").select("candidate_id,concept_id,designer_role,spec,created_at").eq("run_id", researchRunId).order("created_at").limit(12),
    service.from("concept_council_curations").select("batch,metadata,created_at").eq("run_id", researchRunId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    service.from("research_assets").select("id,source_id,original_url,drive_file_id,mime,width,height,roles,why_relevant,must_not_copy,trust,status,observed_at,metadata,created_at").eq("run_id", researchRunId).order("created_at").limit(24),
    service.from("research_image_reference_sets").select("id,concept_id,moment_id,provider_model,provider_limit,reference_set,compiled_lineage,created_at").eq("run_id", researchRunId).order("created_at", { ascending: false }).limit(24),
  ]);

  const queryError = [scoutAssignments.error, runSources.error, evidenceResult.error, packResult.error, designerAssignments.error, candidatesResult.error, curationResult.error, assetsResult.error, referenceSetsResult.error].find(Boolean);
  if (queryError) {
    return apiError("RESEARCH_OBSERVABILITY_FAILED", "Не удалось собрать observability исследования", 500, requestId);
  }

  const sourceIds = [...new Set((runSources.data ?? []).map((row) => String(row.source_id)).filter(Boolean))];
  const jobIds = [...new Set([
    ...(scoutAssignments.data ?? []).map((row) => String(row.factory_job_id)),
    ...(designerAssignments.data ?? []).map((row) => String(row.factory_job_id)),
  ].filter(Boolean))];

  const [sourcesResult, jobsResult] = await Promise.all([
    sourceIds.length
      ? service.from("research_sources").select("id,canonical_url,title,source_type,published_at,observed_at,metadata,created_at").in("id", sourceIds)
      : Promise.resolve({ data: [], error: null }),
    jobIds.length
      ? service.from("factory_jobs").select("id,status,current_stage,progress,retry_count,error,updated_at").in("id", jobIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (sourcesResult.error || jobsResult.error) {
    return apiError("RESEARCH_OBSERVABILITY_FAILED", "Не удалось загрузить research lineage", 500, requestId);
  }

  const jobById = new Map((jobsResult.data ?? []).map((row) => [String(row.id), row]));
  const sourceUse = new Map((runSources.data ?? []).map((row) => [String(row.source_id), row]));
  const scouts = (scoutAssignments.data ?? []).map((row) => {
    const job = jobById.get(String(row.factory_job_id));
    return {
      role: row.scout_role,
      factoryJobId: row.factory_job_id,
      creativeRunId: row.creative_run_id,
      status: job?.status ?? "queued",
      currentStage: job?.current_stage ?? null,
      progress: job?.progress ?? 0,
      retryCount: job?.retry_count ?? 0,
      error: job?.error ?? null,
      updatedAt: job?.updated_at ?? null,
    };
  });
  const conceptDesigners = (designerAssignments.data ?? []).map((row) => {
    const job = jobById.get(String(row.factory_job_id));
    return {
      role: row.designer_role,
      factoryJobId: row.factory_job_id,
      creativeRunId: row.creative_run_id,
      status: job?.status ?? "queued",
      currentStage: job?.current_stage ?? null,
      progress: job?.progress ?? 0,
      retryCount: job?.retry_count ?? 0,
      error: job?.error ?? null,
      updatedAt: job?.updated_at ?? null,
    };
  });
  const legacySources = (sourcesResult.data ?? []).map((row) => {
    const usage = sourceUse.get(String(row.id));
    return {
      id: row.id,
      title: row.title,
      url: row.canonical_url,
      sourceType: row.source_type,
      publishedAt: row.published_at,
      observedAt: row.observed_at,
      scoutRole: usage?.scout_role ?? null,
      relevanceScore: usage?.relevance_score ?? null,
      selected: usage?.selected === true,
      reusedFromCache: usage?.reused_from_cache === true,
    };
  });

  return apiSuccess({
    researchRun,
    researchPack,
    scouts,
    sources: simplifiedSources.length ? simplifiedSources : legacySources,
    evidence: evidenceResult.data ?? [],
    evidencePack: packResult.data ?? null,
    conceptDesigners,
    rawCandidates: (candidatesResult.data ?? []).map((row) => compactConcept(row.spec)),
    curation: curationResult.data ?? null,
    externalVisualReferences: assetsResult.data ?? [],
    imageReferenceSets: referenceSetsResult.data ?? [],
  });
}