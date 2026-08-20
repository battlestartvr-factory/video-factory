import {
  assertSafeWebUrl,
  canonicalizeWebUrl,
  normalizeDomainList,
  toUntrustedEvidenceEnvelope,
  type ImageSearchRequest,
  type ImageSearchResult,
  type SearchResult,
  type SearchFreshnessIntent,
  type TextSearchRequest,
  type UntrustedExternalEvidenceEnvelope,
  type WebDocument,
  type WebFetchProvider,
  type WebImage,
  type WebSearchProvider,
} from "@/lib/web";
import {
  buildResearchCacheKey,
  createResearchCacheEntry,
  isResearchCacheEntryFresh,
  MemoryResearchCacheStore,
  researchCacheTtlMs,
  type ResearchCacheEntry,
  type ResearchCacheStore,
} from "./cache";

export interface CachedResearchResult<T> {
  value: T;
  reusedFromCache: boolean;
  cacheKey: string;
  storedAt: string;
  expiresAt: string;
}

export interface FetchResearchSourceInput {
  url: string;
  query: string;
  freshness?: SearchFreshnessIntent;
  excerptMaxChars?: number;
}

export interface ResearchSourceResult {
  document: WebDocument;
  evidence: UntrustedExternalEvidenceEnvelope;
  reusedFromCache: boolean;
  cacheKey: string;
  duplicateContentCacheKey?: string;
}

export interface FetchResearchImageInput {
  url: string;
  freshness?: SearchFreshnessIntent;
}

export interface ResearchImageResult {
  image: WebImage;
  reusedFromCache: boolean;
  cacheKey: string;
  duplicateContentCacheKey?: string;
}

export interface ResearchToolbox {
  searchText(input: TextSearchRequest): Promise<CachedResearchResult<SearchResult[]>>;
  searchImages(input: ImageSearchRequest): Promise<CachedResearchResult<ImageSearchResult[]>>;
  fetchSource(input: FetchResearchSourceInput): Promise<ResearchSourceResult>;
  fetchImage(input: FetchResearchImageInput): Promise<ResearchImageResult>;
}

export interface ResearchToolboxDependencies {
  searchProvider: WebSearchProvider;
  fetchProvider: WebFetchProvider;
  cache?: ResearchCacheStore;
  now?: () => Date;
}

function normalizedSearchCacheInput(input: TextSearchRequest | ImageSearchRequest) {
  return {
    query: input.query.trim().replace(/\s+/g, " "),
    maxResults: input.maxResults,
    freshness: input.freshness ?? "mixed",
    domainAllowlist: normalizeDomainList(input.domainAllowlist),
    domainDenylist: normalizeDomainList(input.domainDenylist),
  };
}

function entryFreshForRequestedTtl<T>(
  entry: ResearchCacheEntry<T> | null,
  now: Date,
  ttlMs: number,
): entry is ResearchCacheEntry<T> {
  if (!entry || !isResearchCacheEntryFresh(entry, now)) return false;
  return Date.parse(entry.storedAt) + ttlMs > now.getTime();
}

function toCachedResult<T>(key: string, entry: ResearchCacheEntry<T>, reusedFromCache: boolean): CachedResearchResult<T> {
  return {
    value: entry.value,
    reusedFromCache,
    cacheKey: key,
    storedAt: entry.storedAt,
    expiresAt: entry.expiresAt,
  };
}

export function createResearchToolbox(deps: ResearchToolboxDependencies): ResearchToolbox {
  const cache = deps.cache ?? new MemoryResearchCacheStore();
  const now = deps.now ?? (() => new Date());

  return {
    async searchText(input) {
      const normalized = normalizedSearchCacheInput(input);
      const freshness = normalized.freshness;
      const ttlMs = researchCacheTtlMs(freshness);
      const cacheKey = buildResearchCacheKey("research:text-search:v1", normalized);
      const currentTime = now();
      const cached = await cache.get<SearchResult[]>(cacheKey);
      if (entryFreshForRequestedTtl(cached, currentTime, ttlMs)) return toCachedResult(cacheKey, cached, true);

      const value = await deps.searchProvider.searchText({ ...input, freshness });
      const entry = createResearchCacheEntry(value, currentTime, ttlMs);
      await cache.set(cacheKey, entry);
      return toCachedResult(cacheKey, entry, false);
    },

    async searchImages(input) {
      const normalized = normalizedSearchCacheInput(input);
      const freshness = normalized.freshness;
      const ttlMs = researchCacheTtlMs(freshness);
      const cacheKey = buildResearchCacheKey("research:image-search:v1", normalized);
      const currentTime = now();
      const cached = await cache.get<ImageSearchResult[]>(cacheKey);
      if (entryFreshForRequestedTtl(cached, currentTime, ttlMs)) return toCachedResult(cacheKey, cached, true);

      const value = await deps.searchProvider.searchImages({ ...input, freshness });
      const entry = createResearchCacheEntry(value, currentTime, ttlMs);
      await cache.set(cacheKey, entry);
      return toCachedResult(cacheKey, entry, false);
    },

    async fetchSource(input) {
      const safeUrl = assertSafeWebUrl(input.url).toString();
      const canonicalUrl = canonicalizeWebUrl(safeUrl);
      const freshness = input.freshness ?? "mixed";
      const ttlMs = researchCacheTtlMs(freshness);
      const cacheKey = buildResearchCacheKey("research:source-url:v1", canonicalUrl);
      const currentTime = now();
      const cached = await cache.get<WebDocument>(cacheKey);

      let document: WebDocument;
      let reusedFromCache = false;
      if (entryFreshForRequestedTtl(cached, currentTime, ttlMs)) {
        document = cached.value;
        reusedFromCache = true;
      } else {
        document = await deps.fetchProvider.fetchPage(canonicalUrl);
        await cache.set(cacheKey, createResearchCacheEntry(document, currentTime, ttlMs));
      }

      let duplicateContentCacheKey: string | undefined;
      if (document.contentSha256) {
        duplicateContentCacheKey = `research:source-content:v1:${document.contentSha256}`;
        const contentCached = await cache.get<WebDocument>(duplicateContentCacheKey);
        if (!contentCached) {
          await cache.set(duplicateContentCacheKey, createResearchCacheEntry(document, currentTime, ttlMs));
        }
      }

      return {
        document,
        evidence: toUntrustedEvidenceEnvelope(document, input.query, input.excerptMaxChars),
        reusedFromCache,
        cacheKey,
        duplicateContentCacheKey,
      };
    },

    async fetchImage(input) {
      const safeUrl = assertSafeWebUrl(input.url).toString();
      const canonicalUrl = canonicalizeWebUrl(safeUrl);
      const freshness = input.freshness ?? "mixed";
      const ttlMs = researchCacheTtlMs(freshness);
      const cacheKey = buildResearchCacheKey("research:image-url:v1", canonicalUrl);
      const currentTime = now();
      const cached = await cache.get<WebImage>(cacheKey);

      let image: WebImage;
      let reusedFromCache = false;
      if (entryFreshForRequestedTtl(cached, currentTime, ttlMs)) {
        image = cached.value;
        reusedFromCache = true;
      } else {
        image = await deps.fetchProvider.fetchImage(canonicalUrl);
        await cache.set(cacheKey, createResearchCacheEntry(image, currentTime, ttlMs));
      }

      const duplicateContentCacheKey = `research:image-content:v1:${image.contentSha256}`;
      const contentCached = await cache.get<WebImage>(duplicateContentCacheKey);
      if (!contentCached) {
        await cache.set(duplicateContentCacheKey, createResearchCacheEntry(image, currentTime, ttlMs));
      }

      return { image, reusedFromCache, cacheKey, duplicateContentCacheKey };
    },
  };
}
