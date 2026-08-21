import { DurableWorkflowError } from "../orchestrator/retry";
import {
  createKieGeminiGroundedSearchProvider,
  createWebFetchProvider,
  urlSha256,
  type SearchResult,
} from "../web";
import {
  researchScoutEvidenceBundleV1Schema,
  type ResearchEvidenceDraftV1,
  type ResearchScoutEvidenceBundleV1,
  type ResearchSourceCandidateV1,
} from "./evidence-bundle";
import type { ResearchScoutProgressReporter } from "./progress";
import type {
  ResearchScoutExecutionResult,
  ResearchScoutExecutor,
  ResearchScoutJobContext,
} from "./scout-runtime";
import {
  researchScoutReportSpecV1Schema,
  type ResearchScoutRoleV1,
} from "./schemas";
import { createResearchToolbox, type ResearchToolbox } from "./toolbox";

const SAFE_FETCH_CONCURRENCY = 3;

function metadataArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function evidenceType(
  role: ResearchScoutRoleV1,
  index: number,
): ResearchEvidenceDraftV1["evidenceType"] {
  switch (role) {
    case "market_competitor":
      return index % 3 === 2 ? "saturation_signal" : "market_pattern";
    case "mechanics":
      return "mechanic_pattern";
    case "player_voice":
      return index % 2 === 0 ? "player_love" : "player_pain";
    case "gameplay_visual":
      return index % 2 === 0 ? "gameplay_reference_pattern" : "visual_reference_pattern";
    case "white_space_contrarian":
      return index % 2 === 0 ? "white_space" : "counterexample";
  }
}

function freshnessClass(
  value: ResearchScoutJobContext["assignment"]["freshness"],
): ResearchEvidenceDraftV1["freshnessClass"] {
  if (value === "current") return "fresh";
  if (value === "recent") return "recent";
  if (value === "evergreen") return "evergreen";
  return "unknown";
}

function combinedQuery(context: ResearchScoutJobContext): string {
  const assignment = context.assignment;
  return [
    assignment.mandate,
    ...assignment.queryAngles.map((angle) => `Research angle: ${angle}`),
    assignment.sourcePreferences.length
      ? `Prefer source types/domains where useful: ${assignment.sourcePreferences.join(", ")}.`
      : "",
    assignment.forbiddenOverlap.length
      ? `Avoid duplicating these research areas: ${assignment.forbiddenOverlap.join(", ")}.`
      : "",
    assignment.imageSearchRequired
      ? "Also prioritize source pages that contain real gameplay screenshots or visual gameplay evidence."
      : "",
  ].filter(Boolean).join("\n");
}

function groundedClaims(result: SearchResult): string[] {
  const claims = metadataArray(result.providerMetadata?.groundedClaims);
  if (claims.length > 0) return claims;
  return result.snippet?.trim() ? [result.snippet.trim()] : [];
}

function providerUsage(results: SearchResult[]): Record<string, unknown> {
  const first = results[0]?.providerMetadata;
  const usage = first?.usage;
  return usage && typeof usage === "object" && !Array.isArray(usage)
    ? (usage as Record<string, unknown>)
    : {};
}

function adaptiveTopK(input: {
  results: SearchResult[];
  maxFetchedSources: number;
  maxEvidenceItems: number;
  scoutRole: ResearchScoutRoleV1;
}): number {
  const upperBound = Math.min(input.results.length, input.maxFetchedSources);
  if (upperBound <= 1) return upperBound;

  const minSources = Math.min(
    upperBound,
    input.scoutRole === "gameplay_visual" ? 3 : 2,
  );
  const evidenceTarget = Math.max(
    2,
    Math.min(input.maxEvidenceItems, input.scoutRole === "player_voice" ? 5 : 4),
  );

  let claimCapacity = 0;
  let selected = 0;
  for (let index = 0; index < upperBound; index += 1) {
    claimCapacity += Math.max(1, groundedClaims(input.results[index]!).length);
    selected = index + 1;
    if (selected >= minSources && claimCapacity >= evidenceTarget) break;
  }
  return Math.max(minSources, selected);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const output = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      output[index] = await mapper(items[index]!, index);
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      () => worker(),
    ),
  );
  return output;
}

type SourceFetchOutcome =
  | {
      status: "accepted";
      resultIndex: number;
      result: SearchResult;
      fetched: Awaited<ReturnType<ResearchToolbox["fetchSource"]>>;
    }
  | {
      status: "rejected";
      resultIndex: number;
      result: SearchResult;
      error: string;
    };

export class KieGroundedResearchScoutExecutor implements ResearchScoutExecutor {
  constructor(
    private readonly toolbox: ResearchToolbox,
    private readonly now: () => Date = () => new Date(),
    private readonly reportProgress?: ResearchScoutProgressReporter,
  ) {}

  private async progress(
    eventType: Parameters<ResearchScoutProgressReporter>[0]["eventType"],
    key: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.reportProgress) return;
    await this.reportProgress({ eventType, key, payload });
  }

  async execute(input: {
    jobId: string;
    context: ResearchScoutJobContext;
    signal: AbortSignal;
  }): Promise<ResearchScoutExecutionResult> {
    const totalStartedMs = Date.now();
    const { context } = input;
    const budget = context.assignment.budget;
    const generatedAt = this.now().toISOString();

    if (budget.maxSearchQueries < 1 || budget.maxFetchedSources < 1) {
      const emptyBundle: ResearchScoutEvidenceBundleV1 = researchScoutEvidenceBundleV1Schema.parse({
        schema: "research_scout_evidence_bundle",
        version: 1,
        researchRunId: context.researchRunId,
        scoutRole: context.scoutRole,
        sources: [],
        evidence: [],
      });
      return {
        report: researchScoutReportSpecV1Schema.parse({
          schema: "research_scout_report",
          version: 1,
          researchRunId: context.researchRunId,
          scoutRole: context.scoutRole,
          summary: "This Scout had no durable web-search/source budget.",
          sourceIds: [],
          evidenceIds: [],
          imageCandidateIds: [],
          queriesExecuted: 0,
          coverageNotes: ["No web-search budget was available for this assignment."],
          warnings: [],
          generatedAt,
        }),
        evidenceBundle: emptyBundle,
        usage: {
          latency_ms: {
            search: 0,
            safe_fetch: 0,
            evidence: 0,
            total: Math.max(0, Date.now() - totalStartedMs),
          },
        },
        provider: "kie",
        model: "gemini-3-6-flash",
      };
    }

    if (input.signal.aborted) throw input.signal.reason ?? new Error("Research Scout aborted");
    await this.progress("research.scout.started", "scout_started", {
      mandate: context.assignment.mandate.slice(0, 500),
      max_sources: budget.maxFetchedSources,
      max_evidence: budget.maxEvidenceItems,
    });

    const query = combinedQuery(context);
    await this.progress("research.search.started", "search_started", {
      query: query.slice(0, 1_500),
      max_results: budget.maxFetchedSources,
      freshness: context.assignment.freshness,
    });
    if (input.signal.aborted) throw input.signal.reason ?? new Error("Research Scout aborted");

    const searchStartedMs = Date.now();
    const search = await this.toolbox.searchText({
      query,
      maxResults: budget.maxFetchedSources,
      freshness: context.assignment.freshness,
    });
    const searchMs = Math.max(0, Date.now() - searchStartedMs);
    const searchResults = search.value.slice(0, budget.maxFetchedSources);
    const adaptiveK = adaptiveTopK({
      results: searchResults,
      maxFetchedSources: budget.maxFetchedSources,
      maxEvidenceItems: budget.maxEvidenceItems,
      scoutRole: context.scoutRole,
    });
    const fetchCandidates = searchResults.slice(0, adaptiveK);

    await this.progress("research.search.completed", "search_completed", {
      result_count: searchResults.length,
      adaptive_top_k: adaptiveK,
      reused_from_cache: search.reusedFromCache,
      latency_ms: searchMs,
      results: searchResults.slice(0, 8).map((result) => ({
        title: result.title.slice(0, 300),
        url: (result.canonicalUrl ?? result.url).slice(0, 2_000),
        domain: result.domain,
      })),
    });
    if (searchResults.length === 0) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SCOUT_NO_GROUNDED_SOURCES",
        message: "KIE Google Search returned no grounded source URLs for the Scout assignment",
        retryable: false,
        details: { scout_role: context.scoutRole },
      });
    }

    const warnings: string[] = [];
    const safeFetchStartedMs = Date.now();
    const fetchOutcomes = await mapWithConcurrency(
      fetchCandidates,
      SAFE_FETCH_CONCURRENCY,
      async (result, resultIndex): Promise<SourceFetchOutcome> => {
        if (input.signal.aborted) throw input.signal.reason ?? new Error("Research Scout aborted");
        const sourceUrl = result.canonicalUrl ?? result.url;
        await this.progress("research.source.fetch_started", `source_${resultIndex}_fetch_started`, {
          source_index: resultIndex,
          title: result.title.slice(0, 300),
          url: sourceUrl.slice(0, 2_000),
        });
        try {
          const fetched = await this.toolbox.fetchSource({
            url: sourceUrl,
            query: context.assignment.mandate,
            freshness: context.assignment.freshness,
            excerptMaxChars: 6_000,
          });
          if (input.signal.aborted) throw input.signal.reason ?? new Error("Research Scout aborted");
          return { status: "accepted", resultIndex, result, fetched };
        } catch (error) {
          if (input.signal.aborted) throw input.signal.reason ?? error;
          const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
          return { status: "rejected", resultIndex, result, error: message };
        }
      },
    );
    const safeFetchMs = Math.max(0, Date.now() - safeFetchStartedMs);

    const sources: ResearchSourceCandidateV1[] = [];
    const resultBySourceRef = new Map<string, SearchResult>();
    let discoveredPageImageCandidates = 0;

    for (const outcome of fetchOutcomes) {
      const sourceUrl = outcome.result.canonicalUrl ?? outcome.result.url;
      if (outcome.status === "rejected") {
        await this.progress("research.source.rejected", `source_${outcome.resultIndex}_rejected`, {
          source_index: outcome.resultIndex,
          title: outcome.result.title.slice(0, 300),
          url: sourceUrl.slice(0, 2_000),
          error: outcome.error,
        });
        warnings.push(`Source fetch skipped: ${outcome.error}`.slice(0, 240));
        continue;
      }

      const document = outcome.fetched.document;
      const canonicalUrl = document.canonicalUrl ?? document.url;
      const sourceRef = `source-${sources.length + 1}`;
      discoveredPageImageCandidates += document.imageCandidates?.length ?? 0;
      sources.push({
        sourceRef,
        canonicalUrl,
        urlSha256: document.urlSha256 ?? urlSha256(canonicalUrl),
        sourceType: "web_page",
        title: document.title || outcome.result.title,
        ...(document.publishedAt ? { publishedAt: document.publishedAt } : {}),
        observedAt: document.observedAt ?? generatedAt,
        ...(document.fetchedAt ? { fetchedAt: document.fetchedAt } : {}),
        ...(document.contentSha256 ? { contentSha256: document.contentSha256 } : {}),
        extractedText: document.text.slice(0, 16_000),
        relevanceScore: Math.max(0.55, 0.95 - sources.length * 0.05),
        reusedFromCache: outcome.fetched.reusedFromCache,
        metadata: {
          domain: document.domain,
          kie_grounded: true,
          provider_metadata: outcome.result.providerMetadata ?? {},
          page_image_candidate_count: document.imageCandidates?.length ?? 0,
        },
      });
      resultBySourceRef.set(sourceRef, outcome.result);
      await this.progress("research.source.accepted", `source_${outcome.resultIndex}_accepted`, {
        source_index: outcome.resultIndex,
        source_ref: sourceRef,
        title: (document.title || outcome.result.title).slice(0, 300),
        url: canonicalUrl.slice(0, 2_000),
        domain: document.domain,
        reused_from_cache: outcome.fetched.reusedFromCache,
        image_candidate_count: document.imageCandidates?.length ?? 0,
      });
    }

    if (sources.length === 0) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SCOUT_NO_SAFE_FETCHED_SOURCES",
        message: "Grounded search sources were returned, but none passed the safe-fetch boundary",
        retryable: false,
        details: { scout_role: context.scoutRole },
      });
    }

    const evidenceStartedMs = Date.now();
    const evidence: ResearchEvidenceDraftV1[] = [];
    const seenClaims = new Set<string>();
    for (const source of sources) {
      const result = resultBySourceRef.get(source.sourceRef);
      if (!result) continue;
      for (const claim of groundedClaims(result)) {
        const normalized = claim.toLowerCase().replace(/\s+/g, " ").trim();
        if (!normalized || seenClaims.has(normalized)) continue;
        seenClaims.add(normalized);
        const index = evidence.length;
        evidence.push({
          evidenceRef: `evidence-${index + 1}`,
          evidenceType: evidenceType(context.scoutRole, index),
          subject: source.title?.slice(0, 500) || result.title.slice(0, 500),
          claim: claim.slice(0, 4_000),
          sourceRefs: [source.sourceRef],
          confidence: 0.82,
          freshnessClass: freshnessClass(context.assignment.freshness),
          observedAt: source.observedAt,
          tags: [context.scoutRole, "kie_google_search", "grounded"],
          metadata: {
            grounding_chunk_index: result.providerMetadata?.groundingChunkIndex ?? null,
          },
        });
        if (evidence.length >= budget.maxEvidenceItems) break;
      }
      if (evidence.length >= budget.maxEvidenceItems) break;
    }
    const evidenceMs = Math.max(0, Date.now() - evidenceStartedMs);

    if (evidence.length === 0) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SCOUT_GROUNDED_CLAIMS_MISSING",
        message: "KIE returned grounded sources but no grounded claim text usable as evidence",
        retryable: false,
        details: { scout_role: context.scoutRole },
      });
    }

    await this.progress("research.evidence.extracted", "evidence_extracted", {
      evidence_count: evidence.length,
      latency_ms: evidenceMs,
      items: evidence.slice(0, 12).map((item) => ({
        evidence_ref: item.evidenceRef,
        evidence_type: item.evidenceType,
        subject: item.subject.slice(0, 300),
        claim: item.claim.slice(0, 1_000),
        confidence: item.confidence,
      })),
    });

    const evidenceBundle = researchScoutEvidenceBundleV1Schema.parse({
      schema: "research_scout_evidence_bundle",
      version: 1,
      researchRunId: context.researchRunId,
      scoutRole: context.scoutRole,
      sources,
      evidence,
    });
    const summary = evidence.slice(0, 4).map((item) => item.claim).join(" ").slice(0, 3_000);
    const firstMetadata = searchResults[0]?.providerMetadata ?? {};
    const model = typeof firstMetadata.model === "string" ? firstMetadata.model : "gemini-3-6-flash";
    const totalMs = Math.max(0, Date.now() - totalStartedMs);
    const latencyMs = {
      search: searchMs,
      safe_fetch: safeFetchMs,
      evidence: evidenceMs,
      total: totalMs,
    };

    await this.progress("research.scout.execution_completed", "scout_execution_completed", {
      source_count: sources.length,
      evidence_count: evidence.length,
      image_candidate_count: discoveredPageImageCandidates,
      adaptive_top_k: adaptiveK,
      safe_fetch_concurrency: Math.min(SAFE_FETCH_CONCURRENCY, fetchCandidates.length),
      latency_ms: latencyMs,
      model,
    });

    return {
      report: researchScoutReportSpecV1Schema.parse({
        schema: "research_scout_report",
        version: 1,
        researchRunId: context.researchRunId,
        scoutRole: context.scoutRole,
        summary,
        sourceIds: sources.map((source) => source.sourceRef),
        evidenceIds: evidence.map((item) => item.evidenceRef),
        imageCandidateIds: [],
        queriesExecuted: 1,
        coverageNotes: [
          `${sources.length} safely fetched Google-grounded source pages from adaptive Top-${adaptiveK}.`,
          `${evidence.length} grounded evidence claims extracted.`,
          context.assignment.imageSearchRequired
            ? `${discoveredPageImageCandidates} page image candidates discovered without a second paid search provider.`
            : "Visual-source harvesting was not required for this Scout role.",
        ],
        warnings: warnings.slice(0, 20),
        generatedAt,
      }),
      evidenceBundle,
      usage: {
        ...providerUsage(searchResults),
        search_provider: "kie_gemini_google_search",
        search_calls: 1,
        search_result_count: searchResults.length,
        adaptive_top_k: adaptiveK,
        safe_fetch_concurrency: Math.min(SAFE_FETCH_CONCURRENCY, fetchCandidates.length),
        safely_fetched_sources: sources.length,
        page_image_candidates: discoveredPageImageCandidates,
        latency_ms: latencyMs,
      },
      model,
      provider: "kie",
    };
  }
}

export function createKieGroundedResearchScoutExecutor(
  reportProgress?: ResearchScoutProgressReporter,
): ResearchScoutExecutor {
  return {
    async execute(input) {
      const fetchProvider = createWebFetchProvider(undefined, input.signal);
      const searchProvider = createKieGeminiGroundedSearchProvider(fetchProvider, input.signal);
      const executor = new KieGroundedResearchScoutExecutor(
        createResearchToolbox({ searchProvider, fetchProvider }),
        () => new Date(),
        reportProgress,
      );
      return executor.execute(input);
    },
  };
}
