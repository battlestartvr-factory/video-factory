import { getWebSearchConfig } from "@/lib/env/env.server";
import { CONTENT_LIMITS } from "@/lib/agent/config";
import { domainFromUrl, type SearchOptions, type SearchResult, type WebSearchProvider, WebToolError } from "./types";

class NotConfiguredWebSearchProvider implements WebSearchProvider {
  async search(): Promise<SearchResult[]> {
    throw new WebToolError("WEB_SEARCH_NOT_CONFIGURED", "Web search provider is not configured");
  }
}

function mapResults(raw: unknown[], maxResults: number): SearchResult[] {
  const mapped: SearchResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const url = String(row.url ?? row.link ?? "");
    if (!url.startsWith("http")) continue;
    mapped.push({
      title: String(row.title ?? row.name ?? url),
      url,
      domain: domainFromUrl(url),
      publishedAt: row.published_at ? String(row.published_at) : row.publishedAt ? String(row.publishedAt) : undefined,
      snippet: row.snippet ? String(row.snippet) : row.content ? String(row.content).slice(0, 400) : undefined,
    });
    if (mapped.length >= maxResults) break;
  }
  return mapped;
}

class TavilyWebSearchProvider implements WebSearchProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const maxResults = options?.maxResults ?? CONTENT_LIMITS.maxWebSearchResults;
    const response = await fetch(this.baseUrl || "https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: maxResults,
        include_answer: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new WebToolError("WEB_SEARCH_FAILED", `Search provider returned ${response.status}`);
    }
    const payload = (await response.json()) as { results?: unknown[] };
    return mapResults(payload.results ?? [], maxResults);
  }
}

class BraveWebSearchProvider implements WebSearchProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const maxResults = options?.maxResults ?? CONTENT_LIMITS.maxWebSearchResults;
    const endpoint = new URL(this.baseUrl || "https://api.search.brave.com/res/v1/web/search");
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("count", String(maxResults));
    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": this.apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new WebToolError("WEB_SEARCH_FAILED", `Search provider returned ${response.status}`);
    }
    const payload = (await response.json()) as { web?: { results?: unknown[] } };
    return mapResults(payload.web?.results ?? [], maxResults);
  }
}

class GenericWebSearchProvider implements WebSearchProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const maxResults = options?.maxResults ?? CONTENT_LIMITS.maxWebSearchResults;
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ query, max_results: maxResults }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new WebToolError("WEB_SEARCH_FAILED", `Search provider returned ${response.status}`);
    }
    const payload = (await response.json()) as { results?: unknown[] };
    return mapResults(payload.results ?? [], maxResults);
  }
}

export function createWebSearchProvider(): WebSearchProvider {
  const config = getWebSearchConfig();
  if (!config.configured) return new NotConfiguredWebSearchProvider();
  if (config.provider === "tavily") {
    return new TavilyWebSearchProvider(config.apiKey, config.baseUrl);
  }
  if (config.provider === "brave") {
    return new BraveWebSearchProvider(config.apiKey, config.baseUrl);
  }
  if (config.provider === "generic") {
    return new GenericWebSearchProvider(config.apiKey, config.baseUrl);
  }
  return new NotConfiguredWebSearchProvider();
}
