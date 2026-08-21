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
// Quality-first bounded acquisition. A single broad grounded call often exposes only
// one or two grounding chunks, so recovery is driven by VERIFIED post-fetch coverage.
const MAX_KIE_PROVIDER_CALLS = 6;
const MIN_VERIFIED_SOURCES = 4;
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

function usageCallCount(value: unknown, fallback = 1): number {
  const usage = object(value);
  const count = Number(usage.provider_calls ?? fallback);
  return Number.isFinite(count) && count >= 1 ? Math.trunc(count) : fallback;
}

function mergeUsageRecords(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (key === "provider_calls") continue;
    if (typeof value === "number" && typeof merged[key] === "number") {
      merged[key] = Number(merged[key]) + value;
      continue;
    }
    if (typeof value === "boolean" && typeof merged[key] === "boolean") {
      merged[key] = Boolean(merged[key]) || value;
      continue;
    }
    if (!(key in merged)) merged[key] = value;
    else if (merged[key] !== value) merged[`${label}_${key}`] = value;
  }
  return merged;
}

function broadAcquisitionQuery(plan: ResearchPlanSpecV1): string {
  return [
    "PC/Steam friends co-op discovery source acquisition.",
    `Objective: ${plan.researchQuestion}`,
    "Build a diverse evidence library, not a list of store pages.",
    "Target mix: official/store/developer competitors; mechanics/developer/interview/manual material; PLAYER-AUTHORED reviews/community/forum discussion; real gameplay/video/screenshots; and critical comparison/counterexample material.",
    "Player sentiment must come from actual player-authored reviews or community discussion, never a press review, YouTube review, store description, or aggregate rating. Real gameplay evidence must describe or show play rather than key art.",
    "Prefer direct final publisher/developer/store/community/video/editorial URLs. Avoid search-result pages, tracking wrappers, duplicated URLs, key-art-only pages, and unverifiable summaries.",
    "Acquire sources only. Do not generate concepts or perform the five specialist analyses.",
  ].join("\n");
}

function coverageRecoveryQuery(
  plan: ResearchPlanSpecV1,
  targets: SourceCoverageCategory[],
  existingUrls: string[],
): string {
  const instructions: Record<SourceCoverageCategory, string> = {
    competitor: "direct competitor/store/developer pages for mechanically relevant PC/Steam games",
    mechanics: "developer explanation, manual/guide/interview, or detailed gameplay systems covering physics, controls, movement, dependency, abilities, or failure/recovery",
    player_voice: "PLAYER-AUTHORED evidence only: Steam Community discussions/reviews, Reddit discussion threads, GameFAQs/community forums, or equivalent player posts. Do NOT use YouTube reviews, press/editorial reviews, store descriptions, or aggregate ratings as player voice",
    gameplay_visual: "real gameplay footage, gameplay video, screenshots, camera/readability examples, or detailed gameplay descriptions; not key art or trailers without readable play",
    contrarian: "critical review, comparison, counterexample, saturation, or novelty-challenging evidence from a credible independent source",
  };
  return [
    "Targeted PC/Steam co-op research coverage recovery. Acquire sources only.",
    `Objective: ${plan.researchQuestion}`,
    `Acquire NEW direct sources for: ${targets.join(", ")}.`,
    ...targets.map((category) => `Need ${category}: ${instructions[category]}.`),
    existingUrls.length > 0
      ? `Do not repeat these already-verified/attempted URLs: ${existingUrls.slice(-10).join(" ; ")}`
      : "",
    "Prefer a source that Safe Fetch can read as a normal public page. Return direct final URLs, not Google grounding redirects.",
  ].filter(Boolean).join("\n");
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
    || (/\/app\/|\/game\//.test(url) && /steam|epicgames|gog|itch\.io/.test(domain));
  const isCommunityDomain = /reddit\.com|steamcommunity\.com|resetera\.com|neogaf\.com|gamefaqs\.gamespot\.com|forums?\.|community\./.test(domain);
  const isCommunityThread = isCommunityDomain && (
    /\/discussions?\b|\/reviews?\b|\/forum\b|\/comments\b|\/threads?\b/.test(url)
    || /player review|user review|community discussion|forum discussion|players? (?:say|report|discuss|complain|praise)/.test(value)
  );
  const isEditorial = /metacritic\.com|opencritic\.com|rockpapershotgun\.com|eurogamer\.|pcgamer\.|gamespot\.|ign\.|polygon\.|kotaku\./.test(domain)
    || /\bcritique\b|\bcomparison\b/.test(title);
  const isVideo = /youtube\.com|youtu\.be|twitch\.tv|vimeo\.com/.test(domain);
  const explicitGameplay = /\bgameplay\b|\bwalkthrough\b|\bplaythrough\b|\bmatch footage\b|\bscreenshot\b|\bcamera\b/.test(`${title} ${url}`);

  if (isStore || /developer|publisher|official|studio|game\b/.test(`${title} ${domain}`)) {
    categories.add("competitor");
  }
  if (/mechanic|physics|grapple|movement|ability|abilities|control|interaction|system|design|developer|interview|manual|guide|co-?op|teamwork/.test(value)) {
    categories.add("mechanics");
  }
  // Press/video reviews are not player voice. Player voice must come from a
  // player-authored/community source family or explicit player-feedback material.
  if (isCommunityThread || (!isStore && /player-authored|user review|player review|player feedback|community discussion|forum discussion/.test(value))) {
    categories.add("player_voice");
  }
  if (isVideo || explicitGameplay || (!isStore && /gameplay footage|real gameplay|in-game screenshot|camera perspective/.test(value))) {
    categories.add("gameplay_visual");
  }
  if (isEditorial || /comparison|versus|\bvs\b|critical|critique|counterexample|similar games|alternative|saturation|derivative|clone|novelty/.test(value)) {
    categories.add("contrarian");
  }
  return [...categories];
}

function missingCoverage(coverage: Set<SourceCoverageCategory>): SourceCoverageCategory[] {
  return REQUIRED_COVERAGE.filter((category) => !coverage.has(category));
}

function verifiedCoverageOfSources(sources: SharedResearchSourcePoolItemV1[]): Set<SourceCoverageCategory> {
  const coverage = new Set<SourceCoverageCategory>();
  for (const item of sources) {
    for (const category of metadataArray(item.source.metadata.research_source_categories)) {
      if (["competitor", "mechanics", "player_voice", "gameplay_visual", "contrarian"].includes(category)) {
        coverage.add(category as SourceCoverageCategory);
      }
    }
  }
  return coverage;
}

function nextRecoveryTargets(
  missing: SourceCoverageCategory[],
  sourceCount: number,
  minSources: number,
): SourceCoverageCategory[] {
  // Player voice is the most fragile family because editorial/video reviews must not
  // masquerade as player-authored evidence. Recover it independently first.
  for (const category of ["player_voice", "gameplay_visual", "mechanics", "competitor"] as SourceCoverageCategory[]) {
    if (missing.includes(category)) return [category];
  }
  if (sourceCount < minSources) return ["contrarian"];
  return [];
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
  if (isGenericSearchTitle(expected) || isGenericSearchTitle(actual)) return false;

  const expectedTokens = [...new Set(titleTokens(expected))];
  const actualTokens = new Set(titleTokens(actual));
  if (expectedTokens.length < 2 || actualTokens.size < 2) return false;

  const overlap = expectedTokens.filter((token) => actualTokens.has(token)).length;
  if (overlap >= 2) return false;
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
  const query = broadAcquisitionQuery(plan);
  const maxPoolSources = Math.max(1, Math.min(MAX_POOL_SOURCES, plan.budget.maxTotalFetchedSources));
  const minVerifiedSources = Math.min(MIN_VERIFIED_SOURCES, maxPoolSources);

  let totalProviderCalls = 0;
  let searchMs = 0;
  let safeFetchMs = 0;
  let recoveryAttempts = 0;
  let mergedUsage: Record<string, unknown> = {};
  const allResults: SearchResult[] = [];
  const attemptedUrls = new Set<string>();
  const canonicalSeen = new Set<string>();
  const contentSeen = new Set<string>();
  const sources: SharedResearchSourcePoolItemV1[] = [];
  let candidateOrdinal = 0;

  const appendFetchedResults = async (results: SearchResult[], attemptLabel: string): Promise<number> => {
    const fresh = dedupeResults(results).filter((result) => {
      const key = sourceKey(result);
      if (!key || attemptedUrls.has(key)) return false;
      attemptedUrls.add(key);
      return true;
    });
    if (fresh.length === 0 || sources.length >= maxPoolSources) return 0;

    const selected = fresh.slice(0, Math.max(0, maxPoolSources - sources.length + 3));
    const baseOrdinal = candidateOrdinal;
    candidateOrdinal += selected.length;
    const outcomes: Array<{
      result: SearchResult;
      canonicalUrl: string;
      document: Awaited<ReturnType<typeof fetchProvider.fetchPage>>;
      categories: SourceCoverageCategory[];
      claims: string[];
      ordinal: number;
    } | null> = new Array(selected.length).fill(null);
    let cursor = 0;
    const fetchStartedAt = Date.now();

    const worker = async () => {
      while (true) {
        if (input.signal.aborted) throw input.signal.reason ?? new Error("Shared source acquisition aborted");
        const localIndex = cursor++;
        if (localIndex >= selected.length) return;
        const result = selected[localIndex]!;
        const ordinal = baseOrdinal + localIndex;
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
              key: `${attemptLabel}_source_${ordinal}_identity_mismatch`,
              payload: {
                source_index: ordinal,
                search_title: result.title.slice(0, 300),
                fetched_title: document.title.slice(0, 300),
                url: canonicalUrl.slice(0, 2_000),
                reason: "source_identity_mismatch",
              },
            });
            continue;
          }
          const claims = groundedClaims(result);
          const categories = sourceCoverageCategories({
            title: document.title || result.title,
            domain: document.domain,
            url: canonicalUrl,
            text: [...claims, document.text.slice(0, 10_000)].join(" "),
          });
          outcomes[localIndex] = { result, canonicalUrl, document, categories, claims, ordinal };
        } catch (error) {
          if (input.signal.aborted) throw input.signal.reason ?? error;
          await input.reportProgress?.({
            eventType: "research.source_pool.source_rejected",
            key: `${attemptLabel}_source_${ordinal}_rejected`,
            payload: {
              source_index: ordinal,
              title: result.title.slice(0, 300),
              url: rawUrl.slice(0, 2_000),
              error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
            },
          });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(SAFE_FETCH_CONCURRENCY, selected.length) }, () => worker()));
    safeFetchMs += Math.max(0, Date.now() - fetchStartedAt);

    let accepted = 0;
    for (const outcome of outcomes) {
      if (!outcome || sources.length >= maxPoolSources) continue;
      const canonicalKey = normalizeResearchSourceUrl(outcome.canonicalUrl);
      const contentKey = outcome.document.contentSha256?.toLowerCase();
      if (canonicalSeen.has(canonicalKey) || (contentKey && contentSeen.has(contentKey))) {
        await input.reportProgress?.({
          eventType: "research.source_pool.source_rejected",
          key: `${attemptLabel}_source_${outcome.ordinal}_duplicate`,
          payload: {
            source_index: outcome.ordinal,
            url: outcome.canonicalUrl.slice(0, 2_000),
            reason: "canonical_or_content_duplicate",
          },
        });
        continue;
      }

      canonicalSeen.add(canonicalKey);
      if (contentKey) contentSeen.add(contentKey);
      const sourceRef = `pool-source-${sources.length + 1}`;
      const source: ResearchSourceCandidateV1 = researchSourceCandidateV1Schema.parse({
        sourceRef,
        canonicalUrl: outcome.canonicalUrl,
        urlSha256: outcome.document.urlSha256 ?? urlSha256(outcome.canonicalUrl),
        sourceType: "web_page",
        title: outcome.document.title || outcome.result.title,
        ...(outcome.document.publishedAt ? { publishedAt: outcome.document.publishedAt } : {}),
        observedAt: outcome.document.observedAt ?? generatedAt,
        ...(outcome.document.fetchedAt ? { fetchedAt: outcome.document.fetchedAt } : {}),
        ...(outcome.document.contentSha256 ? { contentSha256: outcome.document.contentSha256 } : {}),
        extractedText: outcome.document.text.slice(0, 30_000),
        relevanceScore: Math.max(0.5, 0.97 - sources.length * 0.025),
        reusedFromCache: false,
        metadata: {
          domain: outcome.document.domain,
          kie_grounded: true,
          shared_source_pool: true,
          content_truncated: outcome.document.truncated === true,
          page_image_candidate_count: outcome.document.imageCandidates?.length ?? 0,
          research_source_categories: outcome.categories,
          source_identity_verified: true,
          provider_metadata: outcome.result.providerMetadata ?? {},
        },
      });
      const item = { source, groundedClaims: outcome.claims };
      sources.push(item);
      accepted += 1;
      await input.reportProgress?.({
        eventType: "research.source_pool.source_accepted",
        key: `${attemptLabel}_${sourceRef}_accepted`,
        payload: {
          source_ref: sourceRef,
          title: source.title?.slice(0, 300) ?? "",
          url: source.canonicalUrl.slice(0, 2_000),
          grounded_claim_count: outcome.claims.length,
          categories: outcome.categories,
          content_truncated: source.metadata.content_truncated === true,
        },
      });
    }
    return accepted;
  };

  const runSearch = async (searchQuery: string, maxResults: number, label: string, allowProvenanceRecovery: boolean): Promise<SearchResult[]> => {
    const provider = createSharedPoolKieSearchProvider(input.signal, { allowProvenanceRecovery });
    const startedAt = Date.now();
    try {
      const results = await provider.searchText({
        query: searchQuery,
        maxResults,
        freshness: plan.freshness,
      });
      const calls = providerCallCount(results);
      totalProviderCalls += calls;
      searchMs += Math.max(0, Date.now() - startedAt);
      mergedUsage = mergeUsageRecords(mergedUsage, providerUsage(results), label);
      allResults.push(...results);
      return results;
    } catch (error) {
      searchMs += Math.max(0, Date.now() - startedAt);
      const attachedUsage = object((error as { usage?: unknown }).usage);
      const calls = usageCallCount(attachedUsage, 1);
      totalProviderCalls += calls;
      mergedUsage = mergeUsageRecords(mergedUsage, attachedUsage, label);
      throw error;
    }
  };

  await input.reportProgress?.({
    eventType: "research.source_pool.search_started",
    key: "source_pool_search_started",
    payload: {
      max_results: maxPoolSources,
      research_run_id: input.researchRunId,
      provider_call_cap: MAX_KIE_PROVIDER_CALLS,
      min_verified_sources: minVerifiedSources,
    },
  });
  if (input.signal.aborted) throw input.signal.reason ?? new Error("Shared source acquisition aborted");

  try {
    const primaryResults = await runSearch(query, maxPoolSources, "primary", true);
    await appendFetchedResults(primaryResults, "primary");
  } catch (error) {
    await input.reportProgress?.({
      eventType: "research.source_pool.primary_search_failed",
      key: "source_pool_primary_search_failed",
      payload: {
        provider_calls: totalProviderCalls,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      },
    });
  }

  if (totalProviderCalls > MAX_KIE_PROVIDER_CALLS) {
    const error = new Error(
      `Shared research source acquisition exceeded the hard KIE call cap (${totalProviderCalls} > ${MAX_KIE_PROVIDER_CALLS})`,
    ) as Error & { code?: string; usage?: Record<string, unknown> };
    error.code = "RESEARCH_SHARED_SOURCE_POOL_PROVIDER_CALL_CAP_EXCEEDED";
    error.usage = { ...mergedUsage, provider_calls: totalProviderCalls };
    throw error;
  }

  while (totalProviderCalls < MAX_KIE_PROVIDER_CALLS) {
    const verifiedCoverage = verifiedCoverageOfSources(sources);
    const missing = missingCoverage(verifiedCoverage);
    const targets = nextRecoveryTargets(missing, sources.length, minVerifiedSources);
    if (targets.length === 0) break;

    recoveryAttempts += 1;
    const recoveryKey = `source_pool_verified_recovery_${recoveryAttempts}`;
    await input.reportProgress?.({
      eventType: "research.source_pool.coverage_recovery_started",
      key: `${recoveryKey}_started`,
      payload: {
        recovery_attempt: recoveryAttempts,
        missing_categories: missing,
        target_categories: targets,
        verified_coverage_before: [...verifiedCoverage],
        verified_sources_before: sources.length,
        provider_calls_so_far: totalProviderCalls,
      },
    });

    const recoveryQuery = coverageRecoveryQuery(
      plan,
      targets,
      [...attemptedUrls],
    );
    try {
      const recoveryResults = await runSearch(
        recoveryQuery,
        4,
        `verified_recovery_${recoveryAttempts}`,
        false,
      );
      await appendFetchedResults(recoveryResults, `verified_recovery_${recoveryAttempts}`);
      const afterCoverage = verifiedCoverageOfSources(sources);
      await input.reportProgress?.({
        eventType: "research.source_pool.coverage_recovery_completed",
        key: `${recoveryKey}_completed`,
        payload: {
          recovery_attempt: recoveryAttempts,
          result_count: recoveryResults.length,
          verified_sources_after: sources.length,
          verified_coverage_after: [...afterCoverage],
          missing_categories_after: missingCoverage(afterCoverage),
          total_provider_calls: totalProviderCalls,
        },
      });
    } catch (error) {
      await input.reportProgress?.({
        eventType: "research.source_pool.coverage_recovery_failed",
        key: `${recoveryKey}_failed`,
        payload: {
          recovery_attempt: recoveryAttempts,
          target_categories: targets,
          total_provider_calls: totalProviderCalls,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        },
      });
    }
  }

  const verifiedCoverage = verifiedCoverageOfSources(sources);
  const stillMissing = missingCoverage(verifiedCoverage);
  const finalSearchResults = dedupeResults(allResults);

  await input.reportProgress?.({
    eventType: "research.source_pool.search_completed",
    key: "source_pool_search_completed",
    payload: {
      result_count: finalSearchResults.length,
      provider_calls: totalProviderCalls,
      provider_call_cap: MAX_KIE_PROVIDER_CALLS,
      coverage_recovery_used: recoveryAttempts > 0,
      recovery_attempts: recoveryAttempts,
      verified_coverage: [...verifiedCoverage],
      verified_source_count: sources.length,
      search_ms: searchMs,
      safe_fetch_ms: safeFetchMs,
      results: finalSearchResults.slice(0, 14).map((result) => ({
        title: result.title.slice(0, 300),
        url: (result.canonicalUrl ?? result.url).slice(0, 2_000),
        domain: result.domain,
      })),
    },
  });

  if (sources.length === 0) {
    const error = new Error("Grounded source acquisition produced no Safe-Fetched verified sources") as Error & { code?: string; usage?: Record<string, unknown> };
    error.code = finalSearchResults.length === 0
      ? "RESEARCH_SHARED_SOURCE_POOL_NO_GROUNDED_SOURCES"
      : "RESEARCH_SHARED_SOURCE_POOL_NO_SAFE_SOURCES";
    error.usage = {
      ...mergedUsage,
      provider_calls: totalProviderCalls,
      recovery_attempts: recoveryAttempts,
      safely_fetched_sources: 0,
      missing_coverage: stillMissing,
    };
    throw error;
  }

  if (stillMissing.length > 0 || sources.length < minVerifiedSources) {
    const reasons = [
      stillMissing.length > 0 ? `missing coverage: ${stillMissing.join(", ")}` : "",
      sources.length < minVerifiedSources ? `only ${sources.length}/${minVerifiedSources} verified sources` : "",
    ].filter(Boolean).join("; ");
    const error = new Error(`Verified shared source pool quality gate not met (${reasons})`) as Error & {
      code?: string;
      usage?: Record<string, unknown>;
    };
    error.code = "RESEARCH_SHARED_SOURCE_POOL_COVERAGE_INSUFFICIENT";
    error.usage = {
      ...mergedUsage,
      provider_calls: totalProviderCalls,
      provider_call_cap: MAX_KIE_PROVIDER_CALLS,
      coverage_recovery_used: recoveryAttempts > 0,
      recovery_attempts: recoveryAttempts,
      verified_coverage: [...verifiedCoverage],
      missing_coverage: stillMissing,
      safely_fetched_sources: sources.length,
      min_verified_sources: minVerifiedSources,
    };
    throw error;
  }

  const usage = {
    ...mergedUsage,
    provider_calls: totalProviderCalls,
    search_calls: totalProviderCalls,
    provider_call_cap: MAX_KIE_PROVIDER_CALLS,
    search_provider: "kie_gemini_google_search_shared_pool",
    search_ms: searchMs,
    safe_fetch_ms: safeFetchMs,
    safely_fetched_sources: sources.length,
    coverage_recovery_used: recoveryAttempts > 0,
    recovery_attempts: recoveryAttempts,
    verified_coverage: [...verifiedCoverage],
    min_verified_sources: minVerifiedSources,
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
      coverage_recovery_used: recoveryAttempts > 0,
      recovery_attempts: recoveryAttempts,
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
