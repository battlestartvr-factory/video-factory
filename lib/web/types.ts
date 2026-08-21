import type { WebPageImageCandidate } from "./page-images";

export type SearchFreshnessIntent = "current" | "recent" | "evergreen" | "mixed";

export interface SearchOptions {
  maxResults?: number;
  freshness?: SearchFreshnessIntent;
  domainAllowlist?: string[];
  domainDenylist?: string[];
}

export interface TextSearchRequest extends SearchOptions {
  query: string;
}

export interface ImageSearchRequest extends SearchOptions {
  query: string;
}

export interface SearchResult {
  title: string;
  url: string;
  canonicalUrl?: string;
  domain: string;
  publishedAt?: string;
  snippet?: string;
  observedAt?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface ImageSearchResult {
  title: string;
  imageUrl: string;
  sourceUrl?: string;
  thumbnailUrl?: string;
  canonicalImageUrl?: string;
  canonicalSourceUrl?: string;
  domain: string;
  width?: number;
  height?: number;
  mimeType?: string;
  observedAt?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface WebDocument {
  url: string;
  canonicalUrl?: string;
  title: string;
  domain: string;
  text: string;
  publishedAt?: string;
  observedAt?: string;
  fetchedAt?: string;
  contentType?: string;
  byteLength?: number;
  /** True when an oversized text/HTML response was safely capped at the configured byte boundary. */
  truncated?: boolean;
  urlSha256?: string;
  contentSha256?: string;
  /** Bounded candidates extracted from the already-safe fetched HTML. Never treated as generated assets. */
  imageCandidates?: WebPageImageCandidate[];
}

export interface WebImage {
  url: string;
  canonicalUrl: string;
  domain: string;
  mimeType: string;
  width: number;
  height: number;
  byteLength: number;
  contentSha256: string;
  urlSha256: string;
  observedAt: string;
  fetchedAt: string;
  bytes: Uint8Array;
}

export interface WebSearchProvider {
  /** Legacy universal-agent text search. Kept for backwards compatibility. */
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  searchText(input: TextSearchRequest): Promise<SearchResult[]>;
  searchImages(input: ImageSearchRequest): Promise<ImageSearchResult[]>;
}

export interface WebFetchProvider {
  /** Legacy universal-agent page fetch. Kept for backwards compatibility. */
  fetch(url: string): Promise<WebDocument>;
  fetchPage(url: string): Promise<WebDocument>;
  fetchImage(url: string): Promise<WebImage>;
}

export class WebToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WebToolError";
  }
}

export function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
