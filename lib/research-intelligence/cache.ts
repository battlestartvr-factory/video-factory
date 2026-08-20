import { sha256Hex } from "@/lib/web/normalization";
import type { SearchFreshnessIntent } from "@/lib/web/types";

export interface ResearchCacheEntry<T> {
  value: T;
  storedAt: string;
  expiresAt: string;
}

/**
 * PR2 cache seam. The in-memory implementation is deterministic for tests/local use;
 * PR3 can bind this interface to Research Memory without changing the toolbox contract.
 */
export interface ResearchCacheStore {
  get<T>(key: string): Promise<ResearchCacheEntry<T> | null>;
  set<T>(key: string, entry: ResearchCacheEntry<T>): Promise<void>;
}

export class MemoryResearchCacheStore implements ResearchCacheStore {
  private readonly entries = new Map<string, ResearchCacheEntry<unknown>>();

  async get<T>(key: string): Promise<ResearchCacheEntry<T> | null> {
    return (this.entries.get(key) as ResearchCacheEntry<T> | undefined) ?? null;
  }

  async set<T>(key: string, entry: ResearchCacheEntry<T>): Promise<void> {
    this.entries.set(key, entry as ResearchCacheEntry<unknown>);
  }
}

export const RESEARCH_CACHE_TTL_MS: Record<SearchFreshnessIntent, number> = {
  current: 15 * 60 * 1_000,
  recent: 6 * 60 * 60 * 1_000,
  mixed: 24 * 60 * 60 * 1_000,
  evergreen: 7 * 24 * 60 * 60 * 1_000,
};

export function researchCacheTtlMs(freshness: SearchFreshnessIntent = "mixed"): number {
  return RESEARCH_CACHE_TTL_MS[freshness];
}

export function buildResearchCacheKey(namespace: string, input: unknown): string {
  return `${namespace}:${sha256Hex(JSON.stringify(input))}`;
}

export function createResearchCacheEntry<T>(
  value: T,
  now: Date,
  ttlMs: number,
): ResearchCacheEntry<T> {
  return {
    value,
    storedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

export function isResearchCacheEntryFresh(entry: ResearchCacheEntry<unknown>, now: Date): boolean {
  return Date.parse(entry.expiresAt) > now.getTime();
}
