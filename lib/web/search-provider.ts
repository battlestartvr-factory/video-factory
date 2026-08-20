import { getWebSearchConfig } from "@/lib/env/env.server";
import { CONTENT_LIMITS } from "@/lib/agent/config";
import {
  canonicalizeWebUrl,
  isDomainAllowed,
} from "./normalization";
import {
  domainFromUrl,
  type ImageSearchRequest,
  type ImageSearchResult,
  type SearchOptions,
  type SearchResult,
  type TextSearchRequest,
  type WebSearchProvider,
  WebToolError,
} from "./types";

class NotConfiguredWebSearchProvider implements WebSearchProvider {
  async search(): Promise<SearchResult[]> {
    throw new WebToolError("WEB_SEARCH_NOT_CONFIGURED", "Web search provider is not configured");
  }

  async searchText(): Promise<SearchResult[]> {
    throw new WebToolError("WEB_SEARCH_NOT_CONFIGURED", "Web search provider is not configured");
  }

  async searchImages(): Promise<ImageSearchResult[]> {
    throw new WebToolError("WEB_SEARCH_NOT_CONFIGURED", "Web image search provider is not configured");
  }
}

function boundedMaxResults(maxResults?: number): number {
  const value = maxResults ?? CONTENT_LIMITS.maxWebSearchResults;
  return Math.max(1, Math.min(CONTENT_LIMITS.maxWebSearchResults, Math.trunc(value)));
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : undefined;
}

function safeCanonicalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return canonicalizeWebUrl(url.toString());
  } catch {
    return null;
  }
}

function mapTextResults(
  raw: unknown[],
  request: TextSearchRequest,
  provider: string,
): SearchResult[] {
  const maxResults = boundedMaxResults(request.maxResults);
  const mapped: SearchResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const url = String(row.url ?? row.link ?? "");
    const canonicalUrl = safeCanonicalUrl(url);
    if (!canonicalUrl) continue;
    const domain = domainFromUrl(canonicalUrl);
    if (!isDomainAllowed(domain, request.domainAllowlist, request.domainDenylist)) continue;
    mapped.push({
      title: String(row.title ?? row.name ?? canonicalUrl).slice(0, 500),
      url,
      canonicalUrl,
      domain,
      publishedAt: stringOrUndefined(row.published_at ?? row.publishedAt ?? row.age),
      snippet: stringOrUndefined(row.snippet ?? row.content ?? row.description)?.slice(0, 800),
      observedAt: new Date().toISOString(),
      providerMetadata: { provider },
    });
    if (mapped.length >= maxResults) break;
  }
  return mapped;
}

function extractImageUrl(row: Record<string, unknown>): string | undefined {
  const properties = row.properties && typeof row.properties === "object"
    ? (row.properties as Record<string, unknown>)
    : undefined;
  return stringOrUndefined(
    row.imageUrl ?? row.image_url ?? row.image ?? properties?.url ?? properties?.src ?? row.url,
  );
}

function extractImageSourceUrl(row: Record<string, unknown>): string | undefined {
  return stringOrUndefined(
    row.sourceUrl ?? row.source_url ?? row.pageUrl ?? row.page_url ?? row.source ?? row.context_url ?? row.link,
  );
}

function mapImageResults(
  raw: unknown[],
  request: ImageSearchRequest,
  provider: string,
): ImageSearchResult[] {
  const maxResults = boundedMaxResults(request.maxResults);
  const mapped: ImageSearchResult[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const row: Record<string, unknown> =
      typeof item === "string" ? { imageUrl: item } : item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const imageUrl = extractImageUrl(row);
    if (!imageUrl) continue;
    const canonicalImageUrl = safeCanonicalUrl(imageUrl);
    if (!canonicalImageUrl || seen.has(canonicalImageUrl)) continue;

    const sourceUrl = extractImageSourceUrl(row);
    const canonicalSourceUrl = sourceUrl ? safeCanonicalUrl(sourceUrl) ?? undefined : undefined;
    const domain = domainFromUrl(canonicalSourceUrl ?? canonicalImageUrl);
    if (!isDomainAllowed(domain, request.domainAllowlist, request.domainDenylist)) continue;

    const thumbnail = row.thumbnail && typeof row.thumbnail === "object"
      ? (row.thumbnail as Record<string, unknown>)
      : undefined;
    const thumbnailUrl = stringOrUndefined(row.thumbnailUrl ?? row.thumbnail_url ?? thumbnail?.src ?? thumbnail?.url);
    const properties = row.properties && typeof row.properties === "object"
      ? (row.properties as Record<string, unknown>)
      : undefined;

    seen.add(canonicalImageUrl);
    mapped.push({
      title: String(row.title ?? row.name ?? canonicalSourceUrl ?? canonicalImageUrl).slice(0, 500),
      imageUrl,
      sourceUrl,
      thumbnailUrl,
      canonicalImageUrl,
      canonicalSourceUrl,
      domain,
      width: numberOrUndefined(row.width ?? properties?.width),
      height: numberOrUndefined(row.height ?? properties?.height),
      mimeType: stringOrUndefined(row.mimeType ?? row.mime_type ?? properties?.format),
      observedAt: new Date().toISOString(),
      providerMetadata: { provider },
    });
    if (mapped.length >= maxResults) break;
  }
  return mapped;
}

abstract class BaseWebSearchProvider implements WebSearchProvider {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    return this.searchText({ query, ...options });
  }

  abstract searchText(input: TextSearchRequest): Promise<SearchResult[]>;
  abstract searchImages(input: ImageSearchRequest): Promise<ImageSearchResult[]>;
}

class TavilyWebSearchProvider extends BaseWebSearchProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {
    super();
  }

  private async request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(this.baseUrl || "https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: this.apiKey, include_answer: false, ...body }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new WebToolError("WEB_SEARCH_FAILED", `Search provider returned ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  async searchText(input: TextSearchRequest): Promise<SearchResult[]> {
    const payload = await this.request({
      query: input.query,
      max_results: boundedMaxResults(input.maxResults),
      search_depth: input.freshness === "current" ? "advanced" : "basic",
    });
    return mapTextResults(Array.isArray(payload.results) ? payload.results : [], input, "tavily");
  }

  async searchImages(input: ImageSearchRequest): Promise<ImageSearchResult[]> {
    const payload = await this.request({
      query: input.query,
      max_results: boundedMaxResults(input.maxResults),
      include_images: true,
      include_image_descriptions: true,
    });
    return mapImageResults(Array.isArray(payload.images) ? payload.images : [], input, "tavily");
  }
}

function braveImageEndpoint(baseUrl: string): URL {
  if (!baseUrl) return new URL("https://api.search.brave.com/res/v1/images/search");
  const endpoint = new URL(baseUrl);
  if (/\/web\/search\/?$/.test(endpoint.pathname)) {
    endpoint.pathname = endpoint.pathname.replace(/\/web\/search\/?$/, "/images/search");
  }
  return endpoint;
}

function braveFreshness(value?: SearchOptions["freshness"]): string | undefined {
  if (value === "current") return "pd";
  if (value === "recent") return "pw";
  return undefined;
}

class BraveWebSearchProvider extends BaseWebSearchProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {
    super();
  }

  private async get(endpoint: URL): Promise<Record<string, unknown>> {
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json", "X-Subscription-Token": this.apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new WebToolError("WEB_SEARCH_FAILED", `Search provider returned ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  async searchText(input: TextSearchRequest): Promise<SearchResult[]> {
    const endpoint = new URL(this.baseUrl || "https://api.search.brave.com/res/v1/web/search");
    endpoint.searchParams.set("q", input.query);
    endpoint.searchParams.set("count", String(boundedMaxResults(input.maxResults)));
    const freshness = braveFreshness(input.freshness);
    if (freshness) endpoint.searchParams.set("freshness", freshness);
    const payload = await this.get(endpoint);
    const web = payload.web && typeof payload.web === "object" ? (payload.web as Record<string, unknown>) : undefined;
    return mapTextResults(Array.isArray(web?.results) ? web.results : [], input, "brave");
  }

  async searchImages(input: ImageSearchRequest): Promise<ImageSearchResult[]> {
    const endpoint = braveImageEndpoint(this.baseUrl);
    endpoint.searchParams.set("q", input.query);
    endpoint.searchParams.set("count", String(boundedMaxResults(input.maxResults)));
    const payload = await this.get(endpoint);
    return mapImageResults(Array.isArray(payload.results) ? payload.results : [], input, "brave");
  }
}

class GenericWebSearchProvider extends BaseWebSearchProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {
    super();
  }

  private async request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new WebToolError("WEB_SEARCH_FAILED", `Search provider returned ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  async searchText(input: TextSearchRequest): Promise<SearchResult[]> {
    const payload = await this.request({
      type: "text",
      query: input.query,
      max_results: boundedMaxResults(input.maxResults),
      freshness: input.freshness,
    });
    return mapTextResults(Array.isArray(payload.results) ? payload.results : [], input, "generic");
  }

  async searchImages(input: ImageSearchRequest): Promise<ImageSearchResult[]> {
    const payload = await this.request({
      type: "image",
      query: input.query,
      max_results: boundedMaxResults(input.maxResults),
      freshness: input.freshness,
    });
    const raw = Array.isArray(payload.images) ? payload.images : Array.isArray(payload.results) ? payload.results : [];
    return mapImageResults(raw, input, "generic");
  }
}

export function createWebSearchProvider(): WebSearchProvider {
  const config = getWebSearchConfig();
  if (!config.configured) return new NotConfiguredWebSearchProvider();
  if (config.provider === "tavily") return new TavilyWebSearchProvider(config.apiKey, config.baseUrl);
  if (config.provider === "brave") return new BraveWebSearchProvider(config.apiKey, config.baseUrl);
  if (config.provider === "generic") return new GenericWebSearchProvider(config.apiKey, config.baseUrl);
  return new NotConfiguredWebSearchProvider();
}
