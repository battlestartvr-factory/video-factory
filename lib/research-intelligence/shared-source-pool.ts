import { z } from "zod";
import {
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
import { createSharedPoolKieSearchProvider } from "./shared-pool-kie-search";

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

export type SourceCoverageCategory =
  | "competitor"
  | "mechanics"
  | "player_voice"
  | "gameplay_visual"
  | "contrarian";

const SAFE_FETCH_CONCURRENCY = 3;
const MAX_POOL_SOURCES = 10;
const MAX_KIE_PROVIDER_CALLS = 2;
const REQUIRED_COVERAGE: SourceCoverageCategory[] = [
  "competitor",
  "mechanics",
  "player_voice",
  "gameplay_visual",
];

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

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

function mergeUsage(
  primary: Record<string, unknown>,
  recovery?: Record<string, unknown>,
): Record<string, unknown> {
  if (!recovery) return { ...primary };
  const merged: Record<string, unknown> = { ...primary };
  for (const [key, value] of Object.entries(recovery)) {
    if (typeof value === "number" && typeof merged[key] === "number") {
      merged[key] = Number(merged[key]) + value;
    } else if (!(key in merged)) {
      merged[key] = value;
    } else {
      merged[`coverage_recovery_${key}`] = value;
    }
  }
  return merged;
}

function broadAcquisitionQuery(plan: ResearchPlanSpecV1): string {
  return [
    "PC/Steam friends co-op discovery source acquisition.",
    `Objective: ${plan.researchQuestion}`,
    "Build a diverse evidence library, not a list of store pages.",
    "Target mix: roughly 2 official/store/developer competitor sources; 2 mechanics/developer/interview/manual sources; 2 player-review/community/forum sources; 2 real-gameplay/video/screenshot or detailed gameplay sources; and 1-2 critical comparison/counterexample sources when available.",
    "Player sentiment must come from actual reviews/community discussion, not merely aggregate store ratings. Real gameplay evidence must describe or show play rather than key art.",
    "Prefer direct publisher/developer/store/review/community/video pages. Avoid search-result pages, tracking wrappers, duplicated URLs, key-art-only pages, and unverifiable summaries.",
    "Acquire sources only. Do not generate concepts or perform the five specialist analyses.",
  ].join("\n");
}

function coverageRecoveryQuery(plan: ResearchPlanSpecV1, missing: SourceCoverageCategory[]): string {
  const instructions: Record<SourceCoverageCategory, string> = {
    competitor: "direct competitor/store/developer context",
    mechanics: "mechanics, dependency, physics, controls, developer explanation or detailed gameplay systems",
    player_voice: "actual player reviews, community/forum discussion, recurring love/pain signals",
    gameplay_visual: "real gameplay footage/screenshots/camera/readability or detailed gameplay descriptions",
    contrarian: "critical review, comparison, counterexample, saturation or novelty-challenging evidence",
  };
  return [
    "Targeted PC/Steam co-op research coverage recovery. Acquire sources only.",
    `Objective: ${plan.researchQuestion}`,
    `The existing verified pool is missing these evidence families: ${missing.join(", ")}.`,
    ...missing.map((category) => `Need ${category}: ${instructions[category]}.`),
    "Do not return generic store pages unless they directly fill a missing category. Prefer different domains and direct final URLs.",
  ].join("\n");
}

function groundedClaims(result: SearchResult): string[] {
  const raw = metadataArray(result.providerMetadata?.groundedClaims);
  const candidates = raw.length > 0 ? raw : result.snippet ? [result.snippet] : [];
  return candidates
    .map(sanitizeGroundedEvidenceClaim)
    .filter((value): value is string => Boolean(value));
}

export function normalizeResearchSourceUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    const ignored = ["snr", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
    for (const key of ignored) parsed.searchParams.delete(key);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

function sourceKey(result: SearchResult): string {
  return normalizeResearchSourceUrl(result.canonicalUrl ?? result.url);
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

function hostname(value?: string): string {
  if (!value) return "";
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

export function sourceCoverageCategories(input: {
  title?: string;
  domain?: string;
  url?: string;
  text?: string;
}): SourceCoverageCategory[] {
  const domain = (input.domain || hostname(input.url)).toLowerCase();
  const url = (input.url ?? "").toLowerCase();
  const title = (input.title ?? "").toLowerCase();
  const text = (input.text ?? "").toLowerCase();
  const value = [title, domain, url, text].join(" ");
  const categories = new Set<SourceCoverageCategory>();

  const isStore = /(?:^|\.)(?:store\.steampowered\.com|epicgames\.com|gog\.com|itch\.io)$/.test(domain)
    || /\/app\/|\/game\//.test(url) && /steam|epicgames|gog|itch\.io/.test(domain);
  const isCommunity = /reddit\.com|steamcommunity\.com|resetera\.com|neogaf\.com|gamefaqs\.gamespot\.com|forums?\.|community\./.test(domain)
    || /\/discussions?\b|\/reviews?\b|\/forum\b|\/community\b/.test(url);
  const isReviewEditorial = /metacritic\.com|opencritic\.com|rockpapershotgun\.com|eurogamer\.|pcgamer\.|gamespot\.|ign\.|polygon\.|kotaku\./.test(domain)
    || /\breview\b|\bcritique\b|\bcomparison\b/.test(title);
  const isVideo = /youtube\.com|youtu\.be|twitch\.tv|vimeo\.com/.test(domain);
  const explicitGameplay = /\bgameplay\b|\bwalkthrough\b|\bplaythrough\b|\bmatch footage\b|\bscreenshot\b|\bcamera\b/.test(`${title} ${url}`);

  if (isStore || /developer|publisher|official|studio|game\b/.test(`${title} ${domain}`)) {
    categories.add("competitor");
  }
  if (/mechanic|physics|grapple|movement|ability|abilities|control|interaction|system|design|developer|interview|manual|guide|co-?op|teamwork/.test(value)) {
    categories.add("mechanics");
  }
  // Aggregate ratings on a store page are not enough. Player voice requires an
  // actual discussion/review source family or an explicit reviews/discussions URL.
  if (isCommunity || isReviewEditorial || (!isStore && /user review|player feedback|community discussion|forum discussion/.test(value))) {
    categories.add("player_voice");
  }
  // A store description saying "gameplay" is not a real visual reference. Require
  // video/gameplay-specific destinations or explicit gameplay material outside a store.
  if (isVideo || explicitGameplay || (!isStore && /gameplay footage|real gameplay|in-game screenshot|camera perspective/.test(value))) {
    categories.add("gameplay_visual");
  }
  if (isReviewEditorial || /comparison|versus|\bvs\b|critical|critique|counterexample|similar games|alternative|saturation|derivative|clone|novelty/.test(value)) {
    categories.add("contrarian");
  }
  return [...categories];
}

function coverageOfResults(results: SearchResult[]): Set<SourceCoverageCategory> {
  const coverage = new Set<SourceCoverageCategory>();
  for (const result of results) {
    for (const category of sourceCoverageCategories({
      title: result.title,
      domain: result.domain,
      url: result.canonicalUrl ?? result.url,
      text: [result.snippet, ...metadataArray(result.providerMetadata?.groundedClaims)].filter(Boolean).join(" "),
    })) coverage.add(category);
  }
  return coverage;
}

function missingCoverage(coverage: Set<SourceCoverageCategory>): SourceCoverageCategory[] {
  return REQUIRED_COVERAGE.filter((category) => !coverage.has(category));
}

function titleTokens(value: string): string[] {
  const stop = new Set([
    "on", "steam", "official", "site", "game", "the", "a", "an", "community", "hub",
    "review", "reviews", "forum", "forums", "thread", "general", "discussion", "discussions", "page", "home",
  ]);
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !stop.has(token));
}

export function hasClearResearchSourceTitleMismatch(expected: string, actual: string): boolean {
  // A provider may put the direct URL in the title field, and some Safe Fetch
  // destinations (notably YouTube) expose only a host-like fallback title. Neither
  // is evidence that the grounded destination is a different source.
  if (isGenericSearchTitle(expected) || isGenericSearchTitle(actual)) return false;

  const expectedTokens = [...new Set(titleTokens(expected))];
  const actualTokens = new Set(titleTokens(actual));
  if (expectedTokens.length < 2 || actualTokens.size < 2) return false;

  const overlap = expectedTokens.filter((token) => actualTokens.has(token)).length;
  // Two shared meaningful tokens are a strong entity anchor for shapes such as
  // "Party Animals Forum Physics Thread" -> "Party Animals General Discussions".
  if (overlap >= 2) return false;

  // With no strong anchor, require roughly two thirds of the expected semantic
  // title to survive. This still rejects real cross-game mismatches.
  return overlap / expectedTokens.length < 0.67;
}

function isGenericSearchTitle(value: string): boolean {
  const title = value.trim().toLowerCase();
  if (!title) return true;
  try {
    const parsed = new URL(title);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return true;
  } catch {
    // Not a URL; continue with host-like fallback detection.
  }
  return /^(?:www\.)?[\w.-]+\.(?:com|net|org|io|gg)$/.test(title);
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
  const primaryProvider = createSharedPoolKieSearchProvider(input.signal);
  const query = broadAcquisitionQuery(plan);
  const maxPoolSources = Math.max(1, Math.min(MAX_POOL_SOURCES, plan.budget.maxTotalFetchedSources));

  await input.reportProgress?.({
    eventType: "research.source_pool.search_started",
    key: "source_pool_search_started",
    payload: { max_results: maxPoolSources, research_run_id: input.researchRunId },
  });
  if (input.signal.aborted) throw input.signal.reason ?? new Error("Shared source acquisition aborted");

  const searchStartedAt = Date.now();
  const primaryResults = await primaryProvider.searchText({
    query,
    maxResults: maxPoolSources,
    freshness: plan.freshness,
  });
  const primaryCalls = providerCallCount(primaryResults);
  if (primaryCalls > MAX_KIE_PROVIDER_CALLS) {
    const error = new Error(
      `Shared research source acquisition exceeded the hard KIE call cap (${primaryCalls} > ${MAX_KIE_PROVIDER_CALLS})`,
    ) as Error & { code?: string };
    error.code = "RESEARCH_SHARED_SOURCE_POOL_PROVIDER_CALL_CAP_EXCEEDED";
    throw error;
  }

  let combinedResults = dedupeResults(primaryResults);
  const primaryCoverage = coverageOfResults(combinedResults);
  const primaryMissing = missingCoverage(primaryCoverage);
  let coverageRecoveryUsed = false;
  let recoveryUsage: Record<string, unknown> | undefined;
  let recoveryCalls = 0;

  // The second global search slot is reserved for quality recovery when the primary
  // call did not already consume it for provenance recovery.
  if (primaryMissing.length > 0 && primaryCalls === 1) {
    coverageRecoveryUsed = true;
    await input.reportProgress?.({
      eventType: "research.source_pool.coverage_recovery_started",
      key: "source_pool_coverage_recovery_started",
      payload: { missing_categories: primaryMissing, provider_calls_so_far: primaryCalls },
    });
    try {
      const recoveryProvider = createSharedPoolKieSearchProvider(input.signal, { allowProvenanceRecovery: false });
      const recoveryResults = await recoveryProvider.searchText({
        query: coverageRecoveryQuery(plan, primaryMissing),
        maxResults: Math.min(6, Math.max(3, primaryMissing.length * 2)),
        freshness: plan.freshness,
      });
      recoveryCalls = providerCallCount(recoveryResults);
      if (recoveryCalls !== 1) {
        throw new Error(`Coverage recovery must consume exactly one provider call, got ${recoveryCalls}`);
      }
      recoveryUsage = providerUsage(recoveryResults);
      combinedResults = dedupeResults([...combinedResults, ...recoveryResults]);
      await input.reportProgress?.({
        eventType: "research.source_pool.coverage_recovery_completed",
        key: "source_pool_coverage_recovery_completed",
        payload: {
          result_count: recoveryResults.length,
          missing_categories_before: primaryMissing,
          coverage_after: [...coverageOfResults(combinedResults)],
          total_provider_calls: primaryCalls + recoveryCalls,
        },
      });
    } catch (error) {
      // The network/provider boundary was attempted, so it consumes the final global
      // slot even if the response was unusable. Preserve any provider usage attached
      // to the failure rather than pretending the second paid call never happened.
      recoveryCalls = 1;
      recoveryUsage = object((error as { usage?: unknown }).usage);
      await input.reportProgress?.({
        eventType: "research.source_pool.coverage_recovery_failed",
        key: "source_pool_coverage_recovery_failed",
        payload: {
          missing_categories: primaryMissing,
          total_provider_calls: primaryCalls + recoveryCalls,
          usage: recoveryUsage,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        },
      });
    }
  }

  const totalProviderCalls = primaryCalls + recoveryCalls;
  if (totalProviderCalls > MAX_KIE_PROVIDER_CALLS) {
    const error = new Error(
      `Shared research source acquisition exceeded the hard KIE call cap (${totalProviderCalls} > ${MAX_KIE_PROVIDER_CALLS})`,
    ) as Error & { code?: string };
    error.code = "RESEARCH_SHARED_SOURCE_POOL_PROVIDER_CALL_CAP_EXCEEDED";
    throw error;
  }

  const searchMs = Math.max(0, Date.now() - searchStartedAt);
  await input.reportProgress?.({
    eventType: "research.source_pool.search_completed",
    key: "source_pool_search_completed",
    payload: {
      result_count: combinedResults.length,
      provider_calls: totalProviderCalls,
      provider_call_cap: MAX_KIE_PROVIDER_CALLS,
      coverage_recovery_used: coverageRecoveryUsed,
      coverage_before_fetch: [...coverageOfResults(combinedResults)],
      search_ms: searchMs,
      results: combinedResults.slice(0, 14).map((result) => ({
        title: result.title.slice(0, 300),
        url: (result.canonicalUrl ?? result.url).slice(0, 2_000),
        domain: result.domain,
      })),
    },
  });

  if (combinedResults.length === 0) {
    const error = new Error("Shared KIE source acquisition returned no grounded direct URLs") as Error & { code?: string };
    error.code = "RESEARCH_SHARED_SOURCE_POOL_NO_GROUNDED_SOURCES";
    throw error;
  }

  const selected = combinedResults.slice(0, Math.min(combinedResults.length, maxPoolSources + 4));
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
        if (
          !isGenericSearchTitle(result.title) &&
          document.title &&
          hasClearResearchSourceTitleMismatch(result.title, document.title)
        ) {
          await input.reportProgress?.({
            eventType: "research.source_pool.source_rejected",
            key: `source_pool_source_${index}_identity_mismatch`,
            payload: {
              source_index: index,
              search_title: result.title.slice(0, 300),
              fetched_title: document.title.slice(0, 300),
              url: canonicalUrl.slice(0, 2_000),
              reason: "source_identity_mismatch",
            },
          });
          continue;
        }
        const categories = sourceCoverageCategories({
          title: document.title || result.title,
          domain: document.domain,
          url: canonicalUrl,
          text: [...groundedClaims(result), document.text.slice(0, 8_000)].join(" "),
        });
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
          relevanceScore: Math.max(0.5, 0.96 - index * 0.025),
          reusedFromCache: false,
          metadata: {
            domain: document.domain,
            kie_grounded: true,
            shared_source_pool: true,
            content_truncated: document.truncated === true,
            page_image_candidate_count: document.imageCandidates?.length ?? 0,
            research_source_categories: categories,
            source_identity_verified: true,
            provider_metadata: result.providerMetadata ?? {},
          },
        });
        outcomes[index] = { source, groundedClaims: groundedClaims(result) };
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

  const canonicalSeen = new Set<string>();
  const contentSeen = new Set<string>();
  const sources: SharedResearchSourcePoolItemV1[] = [];
  for (const item of outcomes) {
    if (!item) continue;
    const canonicalKey = normalizeResearchSourceUrl(item.source.canonicalUrl);
    const contentKey = item.source.contentSha256?.toLowerCase();
    if (canonicalSeen.has(canonicalKey) || (contentKey && contentSeen.has(contentKey))) {
      await input.reportProgress?.({
        eventType: "research.source_pool.source_rejected",
        key: `source_pool_source_${item.source.sourceRef}_duplicate`,
        payload: {
          source_ref: item.source.sourceRef,
          url: item.source.canonicalUrl.slice(0, 2_000),
          reason: "canonical_or_content_duplicate",
        },
      });
      continue;
    }
    canonicalSeen.add(canonicalKey);
    if (contentKey) contentSeen.add(contentKey);
    sources.push(item);
    await input.reportProgress?.({
      eventType: "research.source_pool.source_accepted",
      key: `source_pool_${item.source.sourceRef}_accepted`,
      payload: {
        source_ref: item.source.sourceRef,
        title: item.source.title?.slice(0, 300) ?? "",
        url: item.source.canonicalUrl.slice(0, 2_000),
        grounded_claim_count: item.groundedClaims.length,
        categories: metadataArray(item.source.metadata.research_source_categories),
        content_truncated: item.source.metadata.content_truncated === true,
      },
    });
    if (sources.length >= maxPoolSources) break;
  }
  const safeFetchMs = Math.max(0, Date.now() - fetchStartedAt);

  if (sources.length === 0) {
    const error = new Error("Grounded source URLs were found, but no page passed Safe Fetch") as Error & { code?: string };
    error.code = "RESEARCH_SHARED_SOURCE_POOL_NO_SAFE_SOURCES";
    throw error;
  }

  const verifiedCoverage = new Set<SourceCoverageCategory>();
  for (const item of sources) {
    for (const category of metadataArray(item.source.metadata.research_source_categories)) {
      if (["competitor", "mechanics", "player_voice", "gameplay_visual", "contrarian"].includes(category)) {
        verifiedCoverage.add(category as SourceCoverageCategory);
      }
    }
  }
  const stillMissing = missingCoverage(verifiedCoverage);
  if (stillMissing.length > 0) {
    const error = new Error(
      `Verified shared source pool lacks required research coverage: ${stillMissing.join(", ")}`,
    ) as Error & { code?: string; usage?: Record<string, unknown> };
    error.code = "RESEARCH_SHARED_SOURCE_POOL_COVERAGE_INSUFFICIENT";
    error.usage = {
      ...mergeUsage(providerUsage(primaryResults), recoveryUsage),
      provider_calls: totalProviderCalls,
      coverage_recovery_used: coverageRecoveryUsed,
      verified_coverage: [...verifiedCoverage],
      missing_coverage: stillMissing,
      safely_fetched_sources: sources.length,
    };
    throw error;
  }

  const usage = {
    ...mergeUsage(providerUsage(primaryResults), recoveryUsage),
    provider_calls: totalProviderCalls,
    search_calls: totalProviderCalls,
    provider_call_cap: MAX_KIE_PROVIDER_CALLS,
    search_provider: "kie_gemini_google_search_shared_pool",
    search_ms: searchMs,
    safe_fetch_ms: safeFetchMs,
    safely_fetched_sources: sources.length,
    coverage_recovery_used: coverageRecoveryUsed,
    verified_coverage: [...verifiedCoverage],
  };

  await input.reportProgress?.({
    eventType: "research.source_pool.ready",
    key: "source_pool_ready",
    payload: {
      source_count: sources.length,
      provider_calls: totalProviderCalls,
      provider_call_cap: MAX_KIE_PROVIDER_CALLS,
      search_ms: searchMs,
      safe_fetch_ms: safeFetchMs,
      coverage_recovery_used: coverageRecoveryUsed,
      verified_coverage: [...verifiedCoverage],
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