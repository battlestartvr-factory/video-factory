export interface SearchOptions {
  maxResults?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  domain: string;
  publishedAt?: string;
  snippet?: string;
}

export interface WebDocument {
  url: string;
  title: string;
  domain: string;
  text: string;
  publishedAt?: string;
}

export interface WebSearchProvider {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

export interface WebFetchProvider {
  fetch(url: string): Promise<WebDocument>;
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
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
