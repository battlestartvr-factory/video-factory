import { z } from "zod";
import {
  createKieGeminiGroundedSearchProvider,
  createWebFetchProvider,
  urlSha256,
  type SearchResult,
} from "../web";
import {
  researchSourceCandidateV1Schema,
  type ResearchSourceCandidateV1,
} from "./evidence-bundle";
import { sanitizeGroundedEvidenceClaim } from "./kie-research-scout";
import { researchPlanSpecV1Schema, type ResearchPlanSpecV1 } from "./schemas";

const poolClaimSchema = z.string().trim().min(1).max(4_000);

export const sharedResearchSourcePoolItemV1Schema = z.object({
  source: researchSourceCandidateV1Schema,
  groundedClaims: z.array(poolClaimSchema).max(20).default([]),
}).strict();

export const sharedResearchSourcePoolV1Schema = z.object({
  schema: z.literal("shared_research_source_pool"),
  version: z.literal(1),
  researchRunId: z.string().trim().min(1).max(200),
  acquisitionOwnerJobId: z.string().trim().min(1).max(200),
  query: z.string().trim().min(1).max(12_000),
  generatedAt: z.string().datetime({ offset: true }),
  sources: z.array(sharedResearchSourcePoolItemV1Schema).min(1).max(12),
  usage: z.record(z.string(), z.unknown()).default({}),
}).strict();

export type SharedResearchSourcePoolItemV1 = z.infer<typeof sharedResearchSourcePoolItemV1Schema>;
export type SharedResearchSourcePoolV1 = z.infer<typeof sharedResearchSourcePoolV1Schema>;

const SAFE_FETCH_CONCURRENCY = 3;
const MAX_POOL_SOURCES = 10;
const MAX_KIE_PROVIDER_CALLS = 2;

function metadataArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function providerUsage(results: SearchResult[]): Record<string, unknown> {
  const usage = results[0]?.providerMetadata?.usage;
  return usage && typeof usage === "object" && !Array.isArray(usage)
    ? (usage as Record<string, unknown>)
    : {};
}

function providerCallCount(results: SearchResult[]): number {
  const value = Number(providerUsage(results).provider_calls ?? 1);
  return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : 1;
}

function broadAcquisitionQuery(plan: ResearchPlanSpecV1): string {
  const dimensions = plan.scoutAssignments.map((assignment) =>
    `${assignment.role}: ${assignment.mandate} Angles: ${assignment.queryAngles.join("; ")}`,
  );
  return [
    "Build one diverse, source-backed research set for a PC/Steam co-op game discovery council.",
    `Objective: ${plan.researchQuestion}`,
    "Cover ALL five dimensions in one pass: competitors/saturation, mechanics/dependency, repeated player voice, real gameplay/visual grammar, and contrarian/white-space counterexamples.",
    "Prefer direct canonical publisher/developer/store/review/community pages. Include player-review/community sources where player sentiment is claimed. Avoid search-result pages, tracking wrappers, key-art-only pages and unverifiable summaries.",
    "Return enough distinct direct sources that the same verified pool can support five specialist analysts without additional web search.",
    ...dimensions,
  ].join("\n");
}

function groundedClaims(result: SearchResult): string[] {
  const raw = metadataArray(result.providerMetadata?.groundedClaims);
  const candidates = raw.length > 0 ? raw : result.snippet ? [result.snippet] : [];
  return candidates
    .map(sanitizeGroundedEvidenceClaim)
    .filter((value): value is string => Boolean(value));
}

function sourceKey(result: SearchResult): string {
  return (result.canonicalUrl ?? result.url).trim().toLowerCase();
}

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = sourceKey(result);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface SharedSourcePoolProgressEvent {
  eventType: string;
  key: string;
  payload?: Record<string, unknown>;
}

export type SharedSourcePoolProgressReporter = (event: SharedSourcePoolProgressEvent) => Promise<void> | void;

export async function acquireSharedResearchSourcePool(input: {
  researchRunId: string;
  ownerJobId: string;
  plan: ResearchPlanSpecV1;
  signal: AbortSignal;
  reportProgress?: SharedSourcePoolProgressReporter;
}): Promise<SharedResearchSourcePoolV1> {
  const plan = researchPlanSpecV1Schema.parse(input.plan);
  const generatedAt = new Date().toISOString();
  const fetchProvider = createWebFetchProvider(undefined, input.signal);
  const searchProvider = createKieGeminiGroundedSearchProvider(fetchProvider, input.signal);
  const query = broadAcquisitionQuery(plan);

  await input.reportProgress?.({
    eventType: "research.source_pool.search_started",
    key: "source_pool_search_started",
    payload: { max_results: MAX_POOL_SOURCES, research_run_id: input.researchRunId },
  });
  if (input.signal.aborted) throw input.signal.reason ?? new Error("Shared source acquisition aborted");

  const searchStartedAt = Date.now();
  // Exactly one provider-level searchText invocation is permitted for the shared
  // pool. KIE's grounded provider may spend one additional internal provenance
  // recovery call, so the whole Research Run remains hard-capped at <= 2 paid
  // KIE calls. No outer recovery search is allowed here.
  const primaryResults = await searchProvider.searchText({
    query,
    maxResults: MAX_POOL_SOURCES,
    freshness: plan.freshness,
  });
  const providerCalls = providerCallCount(primaryResults);
  if (providerCalls > MAX_KIE_PROVIDER_CALLS) {
    const error = new Error(
      `Shared research source acquisition exceeded the hard KIE call cap (${providerCalls} > ${MAX_KIE_PROVIDER_CALLS})`,
    ) as Error & { code?: string };
    error.code = "RESEARCH_SHARED_SOURCE_POOL_PROVIDER_CALL_CAP_EXCEEDED";
    throw error;
  }
  const allResults = dedupeResults(primaryResults);
  const searchMs = Math.max(0, Date.now() - searchStartedAt);

  await input.reportProgress?.({
    eventType: "research.source_pool.search_completed",
    key: "source_pool_search_completed",
    payload: {
      result_count: allResults.length,
      provider_calls: providerCalls,
      provider_call_cap: MAX_KIE_PROVIDER_CALLS,
      search_ms: searchMs,
      results: allResults.slice(0, 10).map((result) => ({
        title: result.title.slice(0, 300),
        url: (result.canonicalUrl ?? result.url).slice(0, 2_000),
        domain: result.domain,
      })),
    },
  });

  if (allResults.length === 0) {
    const error = new Error("Shared KIE source acquisition returned no grounded direct URLs") as Error & { code?: string };
    error.code = "RESEARCH_SHARED_SOURCE_POOL_NO_GROUNDED_SOURCES";
    throw error;
  }

  const selected = allResults.slice(0, MAX_POOL_SOURCES);
  const outcomes: Array<SharedResearchSourcePoolItemV1 | null> = new Array(selected.length).fill(null);
  let cursor = 0;
  const fetchStartedAt = Date.now();

  const worker = async () => {
    while (true) {
      if (input.signal.aborted) throw input.signal.reason ?? new Error("Shared source acquisition aborted");
      const index = cursor++;
      if (index >= selected.length) return;
      const result = selected[index]!;
      const rawUrl = result.canonicalUrl ?? result.url;
      try {
        const document = await fetchProvider.fetchPage(rawUrl);
        const canonicalUrl = document.canonicalUrl ?? document.url;
        const source: ResearchSourceCandidateV1 = researchSourceCandidateV1Schema.parse({
          sourceRef: `pool-source-${index + 1}`,
          canonicalUrl,
          urlSha256: document.urlSha256 ?? urlSha256(canonicalUrl),
          sourceType: "web_page",
          title: document.title || result.title,
          ...(document.publishedAt ? { publishedAt: document.publishedAt } : {}),
          observedAt: document.observedAt ?? generatedAt,
          ...(document.fetchedAt ? { fetchedAt: document.fetchedAt } : {}),
          ...(document.contentSha256 ? { contentSha256: document.contentSha256 } : {}),
          extractedText: document.text.slice(0, 30_000),
          relevanceScore: Math.max(0.5, 0.96 - index * 0.04),
          reusedFromCache: false,
          metadata: {
            domain: document.domain,
            kie_grounded: true,
            shared_source_pool: true,
            content_truncated: document.truncated === true,
            page_image_candidate_count: document.imageCandidates?.length ?? 0,
            provider_metadata: result.providerMetadata ?? {},
          },
        });
        outcomes[index] = { source, groundedClaims: groundedClaims(result) };
        await input.reportProgress?.({
          eventType: "research.source_pool.source_accepted",
          key: `source_pool_source_${index}_accepted`,
          payload: {
            source_index: index,
            title: source.title?.slice(0, 300) ?? result.title.slice(0, 300),
            url: source.canonicalUrl.slice(0, 2_000),
            grounded_claim_count: outcomes[index]!.groundedClaims.length,
            content_truncated: document.truncated === true,
          },
        });
      } catch (error) {
        if (input.signal.aborted) throw input.signal.reason ?? error;
        await input.reportProgress?.({
          eventType: "research.source_pool.source_rejected",
          key: `source_pool_source_${index}_rejected`,
          payload: {
            source_index: index,
            title: result.title.slice(0, 300),
            url: rawUrl.slice(0, 2_000),
            error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          },
        });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(SAFE_FETCH_CONCURRENCY, selected.length) }, () => worker()));
  const sources = outcomes.filter((item): item is SharedResearchSourcePoolItemV1 => Boolean(item));
  const safeFetchMs = Math.max(0, Date.now() - fetchStartedAt);

  if (sources.length === 0) {
    const error = new Error("Grounded source URLs were found, but no page passed Safe Fetch") as Error & { code?: string };
    error.code = "RESEARCH_SHARED_SOURCE_POOL_NO_SAFE_SOURCES";
    throw error;
  }

  const usage = {
    ...providerUsage(primaryResults),
    provider_calls: providerCalls,
    search_calls: providerCalls,
    provider_call_cap: MAX_KIE_PROVIDER_CALLS,
    search_provider: "kie_gemini_google_search",
    search_ms: searchMs,
    safe_fetch_ms: safeFetchMs,
    safely_fetched_sources: sources.length,
  };

  await input.reportProgress?.({
    eventType: "research.source_pool.ready",
    key: "source_pool_ready",
    payload: {
      source_count: sources.length,
      provider_calls: providerCalls,
      provider_call_cap: MAX_KIE_PROVIDER_CALLS,
      search_ms: searchMs,
      safe_fetch_ms: safeFetchMs,
    },
  });

  return sharedResearchSourcePoolV1Schema.parse({
    schema: "shared_research_source_pool",
    version: 1,
    researchRunId: input.researchRunId,
    acquisitionOwnerJobId: input.ownerJobId,
    query,
    generatedAt,
    sources,
    usage,
  });
}
