import { describe, expect, it, vi } from "vitest";
import {
  adaptiveResearchFetchTopK,
  KieGroundedResearchScoutExecutor,
  RESEARCH_SAFE_FETCH_CONCURRENCY,
} from "../../lib/research-intelligence/kie-research-scout";
import type { ResearchScoutJobContext } from "../../lib/research-intelligence/scout-runtime";
import type { ResearchToolbox } from "../../lib/research-intelligence/toolbox";
import { readKieProviderPayloads } from "../../lib/web/kie-grounded-search";
import type { SearchResult } from "../../lib/web/types";

function scoutContext(): ResearchScoutJobContext {
  return {
    researchRunId: "research-run-latency-test",
    scoutRole: "mechanics",
    assignment: {
      role: "mechanics",
      mandate: "Find mechanically distinct co-op dependency patterns.",
      queryAngles: ["shared systems", "recoverable failure"],
      freshness: "recent",
      sourcePreferences: ["Steam", "developer pages"],
      forbiddenOverlap: [],
      imageSearchRequired: false,
      budget: {
        maxSearchQueries: 1,
        maxFetchedSources: 6,
        maxEvidenceItems: 10,
        maxImageCandidates: 0,
        maxModelCalls: 1,
      },
    },
    creativeRunId: "creative-run-latency-test",
    rootFactoryJobId: "root-job-latency-test",
    rootCreativeRunId: "root-run-latency-test",
    objectiveId: "objective-latency-test",
    existingReport: null,
  };
}

function searchResults(count = 6): SearchResult[] {
  return Array.from({ length: count }, (_, index) => ({
    title: `Grounded source ${index + 1}`,
    url: `https://example${index + 1}.com/game`,
    canonicalUrl: `https://example${index + 1}.com/game`,
    domain: `example${index + 1}.com`,
    snippet: `Source ${index + 1} fallback snippet`,
    providerMetadata: {
      provider: "kie_gemini_google_search",
      model: "gemini-3-6-flash",
      groundedClaims: [
        `Grounded co-op mechanic claim ${index + 1}a.`,
        `Grounded co-op mechanic claim ${index + 1}b.`,
      ],
      usage: { promptTokenCount: 100, candidatesTokenCount: 40 },
    },
  }));
}

function fetchedSource(url: string) {
  const parsed = new URL(url);
  return {
    document: {
      url,
      canonicalUrl: url,
      title: `Fetched ${parsed.hostname}`,
      domain: parsed.hostname,
      text: "Fetched source body with grounded gameplay evidence.",
      observedAt: "2026-08-21T06:00:00.000Z",
      fetchedAt: "2026-08-21T06:00:01.000Z",
      urlSha256: "a".repeat(64),
      contentSha256: "b".repeat(64),
      imageCandidates: [],
    },
    evidence: {},
    reusedFromCache: false,
    cacheKey: `cache:${url}`,
  };
}

function searchResultEnvelope(results = searchResults()) {
  return {
    value: results,
    reusedFromCache: false,
    cacheKey: "search-cache",
    storedAt: "2026-08-21T06:00:00.000Z",
    expiresAt: "2026-08-21T07:00:00.000Z",
  };
}

async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test condition");
}

describe("PR3 research latency hardening", () => {
  it("uses an adaptive Top-K below the hard source budget when enough grounded evidence is expected", () => {
    expect(adaptiveResearchFetchTopK({ resultCount: 6, maxFetchedSources: 6, maxEvidenceItems: 10 })).toBe(4);
    expect(adaptiveResearchFetchTopK({ resultCount: 3, maxFetchedSources: 3, maxEvidenceItems: 5 })).toBe(3);
    expect(adaptiveResearchFetchTopK({ resultCount: 1, maxFetchedSources: 6, maxEvidenceItems: 10 })).toBe(1);
    expect(adaptiveResearchFetchTopK({ resultCount: 0, maxFetchedSources: 6, maxEvidenceItems: 10 })).toBe(0);
  });

  it("parses KIE text/event-stream incrementally across arbitrary byte boundaries without response.text()", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"first":'));
        controller.enqueue(encoder.encode('1}\n\ndata: {"second":"'));
        controller.enqueue(encoder.encode('ok"}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
    const textSpy = vi.spyOn(response, "text");

    await expect(readKieProviderPayloads(response)).resolves.toEqual([
      { first: 1 },
      { second: "ok" },
    ]);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("keeps Safe Fetch bounded and starts no next-wave fetch after Stop is observed", async () => {
    const results = searchResults();
    const pendingFetches: Array<{
      url: string;
      resolve: (value: ReturnType<typeof fetchedSource>) => void;
    }> = [];
    const fetchSource = vi.fn((input: { url: string }) => new Promise<ReturnType<typeof fetchedSource>>((resolve) => {
      pendingFetches.push({ url: input.url, resolve });
    }));
    const toolbox = {
      searchText: vi.fn().mockResolvedValue(searchResultEnvelope(results)),
      fetchSource,
      searchImages: vi.fn(),
      fetchImage: vi.fn(),
    } as unknown as ResearchToolbox;
    const executor = new KieGroundedResearchScoutExecutor(toolbox);
    const controller = new AbortController();

    const execution = executor.execute({
      jobId: "scout-job-latency-stop",
      context: scoutContext(),
      signal: controller.signal,
    });

    await waitFor(() => fetchSource.mock.calls.length === RESEARCH_SAFE_FETCH_CONCURRENCY);
    expect(fetchSource).toHaveBeenCalledTimes(3);
    controller.abort(new Error("user_stop"));
    for (const pending of pendingFetches) pending.resolve(fetchedSource(pending.url));

    await expect(execution).rejects.toThrow("user_stop");
    expect(fetchSource).toHaveBeenCalledTimes(3);
  });

  it("records search/safe-fetch/evidence/total wall-clock metrics and fetch policy in Scout usage", async () => {
    const results = searchResults();
    const fetchSource = vi.fn(async (input: { url: string }) => fetchedSource(input.url));
    const toolbox = {
      searchText: vi.fn().mockResolvedValue(searchResultEnvelope(results)),
      fetchSource,
      searchImages: vi.fn(),
      fetchImage: vi.fn(),
    } as unknown as ResearchToolbox;
    const executor = new KieGroundedResearchScoutExecutor(toolbox);

    const result = await executor.execute({
      jobId: "scout-job-latency-metrics",
      context: scoutContext(),
      signal: new AbortController().signal,
    });

    expect(fetchSource).toHaveBeenCalledTimes(4);
    expect(result.usage).toMatchObject({
      safe_fetch_target: 4,
      safe_fetch_concurrency: 3,
      safely_fetched_sources: 4,
    });
    for (const key of ["search_ms", "safe_fetch_ms", "evidence_ms", "total_ms"] as const) {
      expect(typeof result.usage?.[key]).toBe("number");
      expect(Number(result.usage?.[key])).toBeGreaterThanOrEqual(0);
    }
  });
});
