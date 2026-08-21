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

export const RESEARCH_SAFE_FETCH_CONCURRENCY = 3;

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

export function adaptiveResearchFetchTopK(input: {
  resultCount: number;
  maxFetchedSources: number;
  maxEvidenceItems: number;
}): number {
  const resultCount = Math.max(0, Math.trunc(input.resultCount));
  const maxFetchedSources = Math.max(0, Math.trunc(input.maxFetchedSources));
  if (resultCount === 0 || maxFetchedSources === 0) return 0;

  // Most grounded KIE source rows carry one or more usable claims. Fetch enough
  // pages to establish source diversity without blindly paying the latency cost
  // of every search result. The hard assignment budget remains the upper bound.
  const evidenceDrivenTarget = Math.max(
    2,
    Math.ceil(Math.min(Math.max(1, input.maxEvidenceItems), 8) / 2),
  );
  return Math.min(resultCount, maxFetchedSources, evidenceDrivenTarget);
}

function metadataArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

export function sanitizeGroundedEvidenceClaim(value: string): string | null {
  let claim = value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (!claim) return null;
  if (/^(?:SOURCE|SOURCE_URL|CITATION)\s*[|:]/i.test(claim)) return null;
  if (/^https?:\/\//i.test(claim)) return null;

  claim = claim
    .replace(/^(?:[-•]\s+|\*+\s*)+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!claim || /^(?:SOURCE|SOURCE_URL|CITATION)\s*[|:]/i.test(claim)) return null;
  if (/^[\p{P}\p{S}\s]+$/u.test(claim)) return null;
  const letters = claim.match(/\p{L}/gu)?.length ?? 0;
  const words = claim.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu)?.length ?? 0;
  if (claim.length < 24 || letters < 8 || words < 5) return null;
  return claim.slice(0, 4_000);
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
  const rawClaims = claims.length > 0
    ? claims
    : result.snippet?.trim()
      ? [result.snippet.trim()]
      : [];
  return rawClaims
    .map(sanitizeGroundedEvidenceClaim)
    .filter((claim): claim is string => Boolean(claim));
}

function providerUsage(results: SearchResult[]): Record<string, unknown> {
  const first = results[0]?.providerMetadata;
  const usage = first?.usage;
  return usage && typeof usage === "object" && !Array.isArray(usage)
    ? (usage as Record<string, unknown>)
    : {};
}

function providerCallCount(results: SearchResult[]): number {
  const calls = Number(providerUsage(results).provider_calls ?? 1);
  return Number.isFinite(calls) && calls >= 1 ? Math.trunc(calls) : 1;
}

type FetchSourceResult = Awaited<ReturnType<ResearchToolbox["fetchSource"]>>;

interface SafeFetchOutcome {
  resultIndex: number;
  result: SearchResult;
  fetched?: FetchSourceResult;
  error?: unknown;
}

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
    const totalStartedAt = Date.now();
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
        usage: {},
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

    const searchStartedAt = Date.now();
    const search = await this.toolbox.searchText({
      query,
      maxResults: budget.maxFetchedSources,
      freshness: context.assignment.freshness,
    });
    const searchMs = elapsedMs(searchStartedAt);
    const searchResults = search.value.slice(0, budget.maxFetchedSources);
    const fetchTarget = adaptiveResearchFetchTopK({
      resultCount: searchResults.length,
      maxFetchedSources: budget.maxFetchedSources,
      maxEvidenceItems: budget.maxEvidenceItems,
    });
    const selectedSearchResults = searchResults.slice(0, fetchTarget);
    await this.progress("research.search.completed", "search_completed", {
      result_count: searchResults.length,
      safe_fetch_target: fetchTarget,
      search_ms: searchMs,
      provider_calls: providerCallCount(searchResults),
      provenance_recovery_used: providerUsage(searchResults).provenance_recovery_used === true,
      reused_from_cache: search.reusedFromCache,
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

    const outcomes: Array<SafeFetchOutcome | undefined> = new Array(selectedSearchResults.length);
    const warningsByIndex: Array<string | undefined> = new Array(selectedSearchResults.length);
    let discoveredPageImageCandidates = 0;
    let nextFetchIndex = 0;
    const safeFetchStartedAt = Date.now();
    const workerCount = Math.min(RESEARCH_SAFE_FETCH_CONCURRENCY, selectedSearchResults.length);

    const safeFetchWorker = async (): Promise<void> => {
      while (true) {
        if (input.signal.aborted) throw input.signal.reason ?? new Error("Research Scout aborted");
        const resultIndex = nextFetchIndex;
        nextFetchIndex += 1;
        if (resultIndex >= selectedSearchResults.length) return;

        const result = selectedSearchResults[resultIndex]!;
        const sourceUrl = result.canonicalUrl ?? result.url;
        await this.progress("research.source.fetch_started", `source_${resultIndex}_fetch_started`, {
          source_index: resultIndex,
          title: result.title.slice(0, 300),
          url: sourceUrl.slice(0, 2_000),
        });
        // Stop may be observed while durable progress IO is in flight. Re-check
        // immediately before starting the next Safe Fetch network boundary.
        if (input.signal.aborted) throw input.signal.reason ?? new Error("Research Scout aborted");

        try {
          const fetched = await this.toolbox.fetchSource({
            url: sourceUrl,
            query: context.assignment.mandate,
            freshness: context.assignment.freshness,
            excerptMaxChars: 8_000,
          });
          outcomes[resultIndex] = { resultIndex, result, fetched };
          const document = fetched.document;
          const canonicalUrl = document.canonicalUrl ?? document.url;
          const sourceRef = `source-${resultIndex + 1}`;
          discoveredPageImageCandidates += document.imageCandidates?.length ?? 0;
          await this.progress("research.source.accepted", `source_${resultIndex}_accepted`, {
            source_index: resultIndex,
            source_ref: sourceRef,
            title: (document.title || result.title).slice(0, 300),
            url: canonicalUrl.slice(0, 2_000),
            domain: document.domain,
            reused_from_cache: fetched.reusedFromCache,
            image_candidate_count: document.imageCandidates?.length ?? 0,
          });
        } catch (error) {
          if (input.signal.aborted) throw input.signal.reason ?? error;
          outcomes[resultIndex] = { resultIndex, result, error };
          const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
          warningsByIndex[resultIndex] = `Source fetch skipped: ${message}`.slice(0, 240);
          await this.progress("research.source.rejected", `source_${resultIndex}_rejected`, {
            source_index: resultIndex,
            title: result.title.slice(0, 300),
            url: sourceUrl.slice(0, 2_000),
            error: message,
          });
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => safeFetchWorker()));
    const safeFetchMs = elapsedMs(safeFetchStartedAt);

    const sources: ResearchSourceCandidateV1[] = [];
    const resultBySourceRef = new Map<string, SearchResult>();
    for (const outcome of outcomes) {
      if (!outcome?.fetched) continue;
      const { resultIndex, result, fetched } = outcome;
      const document = fetched.document;
      const canonicalUrl = document.canonicalUrl ?? document.url;
      const sourceRef = `source-${resultIndex + 1}`;
      sources.push({
        sourceRef,
        canonicalUrl,
        urlSha256: document.urlSha256 ?? urlSha256(canonicalUrl),
        sourceType: "web_page",
        title: document.title || result.title,
        ...(document.publishedAt ? { publishedAt: document.publishedAt } : {}),
        observedAt: document.observedAt ?? generatedAt,
        ...(document.fetchedAt ? { fetchedAt: document.fetchedAt } : {}),
        ...(document.contentSha256 ? { contentSha256: document.contentSha256 } : {}),
        extractedText: document.text.slice(0, 30_000),
        relevanceScore: Math.max(0.55, 0.95 - resultIndex * 0.05),
        reusedFromCache: fetched.reusedFromCache,
        metadata: {
          domain: document.domain,
          kie_grounded: true,
          provider_metadata: result.providerMetadata ?? {},
          page_image_candidate_count: document.imageCandidates?.length ?? 0,
        },
      });
      resultBySourceRef.set(sourceRef, result);
    }
    const warnings = warningsByIndex.filter((warning): warning is string => Boolean(warning));

    if (sources.length === 0) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SCOUT_NO_SAFE_FETCHED_SOURCES",
        message: "Grounded search sources were returned, but none passed the safe-fetch boundary",
        retryable: false,
        details: { scout_role: context.scoutRole },
      });
    }

    const evidenceStartedAt = Date.now();
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
          claim,
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
    const evidenceMs = elapsedMs(evidenceStartedAt);

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
      evidence_ms: evidenceMs,
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
    const summary = evidence.slice(0, 4).map((item) => item.claim).join(" ").slice(0, 4_000);
    const firstMetadata = searchResults[0]?.providerMetadata ?? {};
    const model = typeof firstMetadata.model === "string" ? firstMetadata.model : "gemini-3-6-flash";

    await this.progress("research.scout.execution_completed", "scout_execution_completed", {
      source_count: sources.length,
      evidence_count: evidence.length,
      image_candidate_count: discoveredPageImageCandidates,
      safe_fetch_target: fetchTarget,
      safe_fetch_concurrency: workerCount,
      provider_calls: providerCallCount(searchResults),
      search_ms: searchMs,
      safe_fetch_ms: safeFetchMs,
      evidence_ms: evidenceMs,
      total_ms: elapsedMs(totalStartedAt),
      model,
    });
    const totalMs = elapsedMs(totalStartedAt);

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
          `${sources.length} safely fetched Google-grounded source pages (${fetchTarget} adaptive Top-K target).`,
          `${evidence.length} quality-filtered grounded evidence claims extracted.`,
          providerUsage(searchResults).provenance_recovery_used === true
            ? "One bounded provenance-only recovery call was required; no worker retry was used for missing grounding."
            : "Primary grounded search exposed verifiable provenance without recovery.",
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
        search_calls: providerCallCount(searchResults),
        safe_fetch_target: fetchTarget,
        safe_fetch_concurrency: workerCount,
        safely_fetched_sources: sources.length,
        page_image_candidates: discoveredPageImageCandidates,
        search_ms: searchMs,
        safe_fetch_ms: safeFetchMs,
        evidence_ms: evidenceMs,
        total_ms: totalMs,
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
