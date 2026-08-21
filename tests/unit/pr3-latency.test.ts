import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KieGeminiGroundedSearchProvider, type SearchResult, type WebFetchProvider } from "@/lib/web";
import { KieGroundedResearchScoutExecutor } from "@/lib/research-intelligence/kie-research-scout";
import type { ResearchScoutJobContext } from "@/lib/research-intelligence/scout-runtime";
import type { ResearchToolbox } from "@/lib/research-intelligence/toolbox";

const originalFetch = globalThis.fetch;
const scoutSource = readFileSync(
  join(process.cwd(), "lib/research-intelligence/kie-research-scout.ts"),
  "utf8",
);
const kieSource = readFileSync(join(process.cwd(), "lib/web/kie-grounded-search.ts"), "utf8");

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function context(overrides?: Partial<ResearchScoutJobContext["assignment"]["budget"]>): ResearchScoutJobContext {
  return {
    researchRunId: "research-run-pr3",
    scoutRole: "mechanics",
    assignment: {
      role: "mechanics",
      mandate: "Find mechanically interdependent co-op patterns.",
      queryAngles: ["shared systems", "recoverable failure"],
      freshness: "recent",
      sourcePreferences: ["Steam", "developer pages"],
      forbiddenOverlap: [],
      imageSearchRequired: false,
      budget: {
        maxSearchQueries: 1,
        maxFetchedSources: 4,
        maxEvidenceItems: 4,
        maxImageCandidates: 0,
        maxModelCalls: 1,
        ...overrides,
      },
    },
    creativeRunId: "scout-run-pr3",
    rootFactoryJobId: "root-job-pr3",
    rootCreativeRunId: "root-run-pr3",
    objectiveId: "objective-pr3",
    existingReport: null,
  };
}

function result(index: number, claimCount: number): SearchResult {
  return {
    title: `Source ${index}`,
    url: `https://example${index}.com/game`,
    canonicalUrl: `https://example${index}.com/game`,
    domain: `example${index}.com`,
    providerMetadata: {
      provider: "kie_gemini_google_search",
      model: "gemini-3-6-flash",
      groundedClaims: Array.from(
        { length: claimCount },
        (_, claimIndex) => `Grounded mechanic claim ${index}.${claimIndex + 1}`,
      ),
      usage: { promptTokenCount: 50, candidatesTokenCount: 20 },
    },
  };
}

function fetchedDocument(url: string) {
  const domain = new URL(url).hostname;
  return {
    document: {
      url,
      canonicalUrl: url,
      title: `Fetched ${domain}`,
      domain,
      text: "Source body with enough mechanically relevant evidence.",
      observedAt: "2026-08-21T06:00:00.000Z",
      fetchedAt: "2026-08-21T06:00:01.000Z",
      urlSha256: "a".repeat(64),
      contentSha256: "b".repeat(64),
      imageCandidates: [],
    },
    evidence: {},
    reusedFromCache: false,
    cacheKey: `source:${url}`,
  };
}

function toolbox(searchResults: SearchResult[], fetchSource: ResearchToolbox["fetchSource"]): ResearchToolbox {
  return {
    searchText: vi.fn().mockResolvedValue({
      value: searchResults,
      reusedFromCache: false,
      cacheKey: "search-pr3",
      storedAt: "2026-08-21T06:00:00.000Z",
      expiresAt: "2026-08-21T07:00:00.000Z",
    }),
    fetchSource,
    searchImages: vi.fn(),
    fetchImage: vi.fn(),
  } as unknown as ResearchToolbox;
}

describe("PR3 latency contract — no real provider calls", () => {
  it("uses bounded parallel Safe Fetch and shrinks Top-K when early grounded claims already cover the evidence target", async () => {
    const searchResults = [result(1, 2), result(2, 2), result(3, 1), result(4, 1)];
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const fetchSource = vi.fn(async (input: { url: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) release();
      await gate;
      active -= 1;
      return fetchedDocument(input.url);
    }) as unknown as ResearchToolbox["fetchSource"];

    const executor = new KieGroundedResearchScoutExecutor(toolbox(searchResults, fetchSource));
    const execution = await executor.execute({
      jobId: "scout-job-pr3",
      context: context(),
      signal: new AbortController().signal,
    });

    expect(fetchSource).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(2);
    expect(execution.usage?.adaptive_top_k).toBe(2);
    expect(execution.usage?.safe_fetch_concurrency).toBe(2);
    expect(execution.evidenceBundle?.sources).toHaveLength(2);
    expect(execution.evidenceBundle?.evidence).toHaveLength(4);
    expect(execution.usage?.latency_ms).toMatchObject({
      search: expect.any(Number),
      safe_fetch: expect.any(Number),
      evidence: expect.any(Number),
      total: expect.any(Number),
    });
  });

  it("expands adaptive Top-K when grounded claim density is sparse", async () => {
    const searchResults = [result(1, 1), result(2, 1), result(3, 1), result(4, 1)];
    const fetchSource = vi.fn(async (input: { url: string }) => fetchedDocument(input.url)) as unknown as ResearchToolbox["fetchSource"];
    const executor = new KieGroundedResearchScoutExecutor(toolbox(searchResults, fetchSource));

    const execution = await executor.execute({
      jobId: "scout-job-pr3-sparse",
      context: context(),
      signal: new AbortController().signal,
    });

    expect(fetchSource).toHaveBeenCalledTimes(4);
    expect(execution.usage?.adaptive_top_k).toBe(4);
    expect(execution.evidenceBundle?.sources).toHaveLength(4);
    expect(execution.evidenceBundle?.evidence).toHaveLength(4);
  });

  it("consumes KIE text/event-stream incrementally across arbitrary network chunk boundaries and requests compact output", async () => {
    const payload = {
      candidates: [
        {
          content: { parts: [{ text: "Compact grounded answer." }] },
          groundingMetadata: {
            webSearchQueries: ["co-op mechanics"],
            groundingChunks: [
              { web: { uri: "https://example.com/game", title: "Example Game" } },
            ],
            groundingSupports: [
              {
                segment: { text: "Players must coordinate one shared physical system." },
                groundingChunkIndices: [0],
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 25 },
    };
    const wire = `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(wire.slice(0, 13)));
        controller.enqueue(encoder.encode(wire.slice(13, 47)));
        controller.enqueue(encoder.encode(wire.slice(47)));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    globalThis.fetch = fetchMock as typeof fetch;
    const unusedFetchProvider: WebFetchProvider = {
      fetch: async () => { throw new Error("unused"); },
      fetchPage: async () => { throw new Error("unused"); },
      fetchImage: async () => { throw new Error("unused"); },
    };
    const provider = new KieGeminiGroundedSearchProvider(
      "https://api.kie.ai",
      "test-key",
      "gemini-3-6-flash",
      unusedFetchProvider,
    );

    const results = await provider.searchText({ query: "co-op mechanics", maxResults: 3 });

    expect(results).toHaveLength(1);
    expect(results[0]?.providerMetadata?.usage).toMatchObject({
      transport_streamed: true,
      stream_payload_count: 1,
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.generationConfig).toEqual({ temperature: 0.1, maxOutputTokens: 1024 });
  });

  it("keeps the PR3 implementation explicitly bounded and stream-oriented", () => {
    expect(scoutSource).toContain("const SAFE_FETCH_CONCURRENCY = 3");
    expect(scoutSource).toContain("mapWithConcurrency");
    expect(scoutSource).toContain("adaptive_top_k");
    expect(scoutSource).toContain("latency_ms");
    expect(kieSource).toContain("response.body.getReader()");
    expect(kieSource).toContain("maxOutputTokens: 1024");
    expect(kieSource).toContain("transport_streamed");
  });
});
