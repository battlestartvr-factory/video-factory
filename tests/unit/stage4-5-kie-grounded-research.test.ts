import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KieGeminiGroundedSearchProvider,
  extractPageImageCandidates,
  type SearchResult,
  type WebDocument,
  type WebFetchProvider,
  type WebImage,
} from "@/lib/web";
import { KieGroundedResearchScoutExecutor } from "@/lib/research-intelligence/kie-research-scout";
import type { ResearchScoutJobContext } from "@/lib/research-intelligence/scout-runtime";
import type { ResearchToolbox } from "@/lib/research-intelligence/toolbox";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function groundedPayload() {
  return {
    candidates: [
      {
        content: {
          parts: [{ text: "Shared-object co-op creates visible coordination and recoverable failure." }],
        },
        groundingMetadata: {
          webSearchQueries: ["shared object co-op gameplay examples"],
          groundingChunks: [
            {
              web: {
                uri: "https://store.steampowered.com/app/123/example_game?utm_source=google",
                title: "Example Game on Steam",
              },
            },
            {
              web: {
                uri: "https://example.com/review",
                title: "Example Game review",
              },
            },
          ],
          groundingSupports: [
            {
              segment: {
                text: "The game requires two players to coordinate a shared physical object.",
              },
              groundingChunkIndices: [0],
            },
            {
              segment: {
                text: "Players praise recoverable failures that create social stories.",
              },
              groundingChunkIndices: [1],
            },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 60 },
  };
}

function mockKieResponse(payload: unknown = groundedPayload()) {
  const fetchMock = vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  globalThis.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

function unusedImage(): Promise<WebImage> {
  throw new Error("not used");
}

function pageFetchProvider(imageCandidates: WebDocument["imageCandidates"] = []): WebFetchProvider {
  const document: WebDocument = {
    url: "https://store.steampowered.com/app/123/example_game",
    canonicalUrl: "https://store.steampowered.com/app/123/example_game",
    title: "Example Game",
    domain: "store.steampowered.com",
    text: "Example source page.",
    imageCandidates,
  };
  return {
    fetch: vi.fn().mockResolvedValue(document),
    fetchPage: vi.fn().mockResolvedValue(document),
    fetchImage: unusedImage,
  };
}

function scoutContext(role: ResearchScoutJobContext["scoutRole"] = "mechanics"): ResearchScoutJobContext {
  return {
    researchRunId: "research-run-1",
    scoutRole: role,
    assignment: {
      role,
      mandate: "Find current co-op mechanic patterns with clear mechanical dependency.",
      queryAngles: ["shared physical systems", "recoverable coordination failure"],
      freshness: "recent",
      sourcePreferences: ["Steam", "developer pages", "player reviews"],
      forbiddenOverlap: [],
      imageSearchRequired: role === "gameplay_visual",
      budget: {
        maxSearchQueries: 4,
        maxFetchedSources: 3,
        maxEvidenceItems: 5,
        maxImageCandidates: 4,
        maxModelCalls: 1,
      },
    },
    creativeRunId: "scout-run-1",
    rootFactoryJobId: "root-job-1",
    rootCreativeRunId: "root-run-1",
    objectiveId: "objective-1",
    existingReport: null,
  };
}

describe("KIE-only source-page visual discovery", () => {
  it("extracts bounded real web image candidates with relative URL resolution and ignores data URLs", () => {
    const html = `
      <html><head>
        <meta property="og:image" content="/media/hero.jpg">
        <meta name="twitter:image" content="https://cdn.example.com/social.jpg">
      </head><body>
        <img src="/screens/gameplay-01.jpg" width="1280" height="720" alt="two player co-op gameplay screenshot">
        <img src="data:image/png;base64,AAAA" alt="inline data image">
        <img srcset="/screens/small.jpg 640w, /screens/large.jpg 1600w" alt="gameplay arena">
      </body></html>`;

    const candidates = extractPageImageCandidates(html, new URL("https://example.com/game/page"));
    expect(candidates.map((candidate) => candidate.canonicalUrl)).toEqual([
      "https://example.com/media/hero.jpg",
      "https://cdn.example.com/social.jpg",
      "https://example.com/screens/gameplay-01.jpg",
      "https://example.com/screens/large.jpg",
    ]);
    expect(candidates[2]).toMatchObject({ width: 1280, height: 720, kind: "image_src" });
  });

  it("uses one KIE Google-grounded call, then harvests images from grounded source pages", async () => {
    const fetchMock = mockKieResponse();
    const provider = new KieGeminiGroundedSearchProvider(
      "https://api.kie.ai",
      "test-key",
      "gemini-3-6-flash",
      pageFetchProvider([
        {
          url: "https://cdn.example.com/logo.png",
          canonicalUrl: "https://cdn.example.com/logo.png",
          kind: "image_src",
          alt: "publisher logo",
          width: 600,
          height: 180,
        },
        {
          url: "https://cdn.example.com/gameplay.jpg",
          canonicalUrl: "https://cdn.example.com/gameplay.jpg",
          kind: "image_src",
          alt: "co-op gameplay screenshot shared object",
          width: 1280,
          height: 720,
        },
      ]),
    );

    const images = await provider.searchImages({ query: "readable co-op shared object gameplay", maxResults: 2 });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(images[0]).toMatchObject({
      imageUrl: "https://cdn.example.com/gameplay.jpg",
      sourceUrl: "https://store.steampowered.com/app/123/example_game",
      canonicalSourceUrl: "https://store.steampowered.com/app/123/example_game",
    });
    expect(images.some((item) => item.imageUrl.includes("logo"))).toBe(false);
  });
});

describe("KIE Gemini Google Search grounding contract", () => {
  it("sends the native Google Search tool and preserves exact grounded source provenance", async () => {
    const fetchMock = mockKieResponse();
    const provider = new KieGeminiGroundedSearchProvider(
      "https://api.kie.ai",
      "test-key",
      "gemini-3-6-flash",
      pageFetchProvider(),
    );

    const results = await provider.searchText({ query: "current co-op mechanic patterns", maxResults: 2 });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      canonicalUrl: "https://store.steampowered.com/app/123/example_game",
      domain: "store.steampowered.com",
    });
    expect(results[0]?.providerMetadata?.groundedClaims).toEqual([
      "The game requires two players to coordinate a shared physical object.",
    ]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/gemini/v1/models/gemini-3-6-flash:streamGenerateContent");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.tools).toEqual([{ googleSearch: {} }]);
  });

  it("fails closed after one bounded recovery when KIE returns prose without grounding URLs", async () => {
    const fetchMock = mockKieResponse({ candidates: [{ content: { parts: [{ text: "Ungrounded answer" }] } }] });
    const provider = new KieGeminiGroundedSearchProvider(
      "https://api.kie.ai",
      "test-key",
      "gemini-3-6-flash",
      pageFetchProvider(),
    );

    await expect(provider.searchText({ query: "co-op games" })).rejects.toMatchObject({
      code: "WEB_SEARCH_GROUNDING_MISSING",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("production KIE Research Scout", () => {
  it("uses one grounded search call, safe source fetches, and emits source-backed typed evidence", async () => {
    const searchResults: SearchResult[] = [
      {
        title: "Steam Example",
        url: "https://store.steampowered.com/app/123/example_game",
        canonicalUrl: "https://store.steampowered.com/app/123/example_game",
        domain: "store.steampowered.com",
        snippet: "fallback snippet",
        providerMetadata: {
          provider: "kie_gemini_google_search",
          model: "gemini-3-6-flash",
          groundedClaims: [
            "The mechanic requires both players to manipulate one shared physical system.",
            "A failed timing window creates a visible recoverable coordination failure.",
          ],
          usage: { promptTokenCount: 100, candidatesTokenCount: 40 },
        },
      },
    ];
    const searchText = vi.fn().mockResolvedValue({
      value: searchResults,
      reusedFromCache: false,
      cacheKey: "search-cache",
      storedAt: "2026-08-20T12:00:00.000Z",
      expiresAt: "2026-08-20T13:00:00.000Z",
    });
    const fetchSource = vi.fn().mockResolvedValue({
      document: {
        url: searchResults[0]!.url,
        canonicalUrl: searchResults[0]!.canonicalUrl,
        title: "Steam Example",
        domain: "store.steampowered.com",
        text: "Fetched source body with gameplay mechanic details.",
        observedAt: "2026-08-20T12:00:00.000Z",
        fetchedAt: "2026-08-20T12:00:01.000Z",
        urlSha256: "a".repeat(64),
        contentSha256: "b".repeat(64),
        imageCandidates: [
          {
            url: "https://cdn.example.com/gameplay.jpg",
            canonicalUrl: "https://cdn.example.com/gameplay.jpg",
            kind: "image_src",
            alt: "gameplay screenshot",
            width: 1280,
            height: 720,
          },
        ],
      },
      evidence: {},
      reusedFromCache: false,
      cacheKey: "source-cache",
    });
    const toolbox = {
      searchText,
      fetchSource,
      searchImages: vi.fn(),
      fetchImage: vi.fn(),
    } as unknown as ResearchToolbox;
    const executor = new KieGroundedResearchScoutExecutor(
      toolbox,
      () => new Date("2026-08-20T12:05:00.000Z"),
    );

    const result = await executor.execute({
      jobId: "scout-job-1",
      context: scoutContext("mechanics"),
      signal: new AbortController().signal,
    });

    expect(searchText).toHaveBeenCalledOnce();
    expect(fetchSource).toHaveBeenCalledOnce();
    expect(result.report.queriesExecuted).toBe(1);
    expect(result.report.sourceIds).toEqual(["source-1"]);
    expect(result.report.evidenceIds).toEqual(["evidence-1", "evidence-2"]);
    expect(result.evidenceBundle?.sources).toHaveLength(1);
    expect(result.evidenceBundle?.evidence).toHaveLength(2);
    expect(result.evidenceBundle?.evidence.every((item) => item.sourceRefs[0] === "source-1")).toBe(true);
    expect(result.provider).toBe("kie");
    expect(result.model).toBe("gemini-3-6-flash");
  });

  it("records source-page image discovery for the gameplay/visual Scout without inventing durable image IDs", async () => {
    const context = scoutContext("gameplay_visual");
    const searchText = vi.fn().mockResolvedValue({
      value: [
        {
          title: "Gameplay page",
          url: "https://example.com/gameplay",
          canonicalUrl: "https://example.com/gameplay",
          domain: "example.com",
          providerMetadata: {
            model: "gemini-3-6-flash",
            groundedClaims: ["The screenshots show a shared-object co-op interaction clearly."],
          },
        },
      ],
      reusedFromCache: false,
      cacheKey: "search-cache",
      storedAt: "2026-08-20T12:00:00.000Z",
      expiresAt: "2026-08-20T13:00:00.000Z",
    });
    const fetchSource = vi.fn().mockResolvedValue({
      document: {
        url: "https://example.com/gameplay",
        canonicalUrl: "https://example.com/gameplay",
        title: "Gameplay page",
        domain: "example.com",
        text: "gameplay source",
        observedAt: "2026-08-20T12:00:00.000Z",
        urlSha256: "c".repeat(64),
        contentSha256: "d".repeat(64),
        imageCandidates: [
          { url: "https://cdn.example.com/a.jpg", canonicalUrl: "https://cdn.example.com/a.jpg", kind: "image_src" },
          { url: "https://cdn.example.com/b.jpg", canonicalUrl: "https://cdn.example.com/b.jpg", kind: "og_image" },
        ],
      },
      evidence: {},
      reusedFromCache: false,
      cacheKey: "source-cache",
    });
    const executor = new KieGroundedResearchScoutExecutor({
      searchText,
      fetchSource,
      searchImages: vi.fn(),
      fetchImage: vi.fn(),
    } as unknown as ResearchToolbox);

    const result = await executor.execute({
      jobId: "visual-scout-job",
      context,
      signal: new AbortController().signal,
    });

    expect(result.report.imageCandidateIds).toEqual([]);
    expect(result.report.coverageNotes.join(" ")).toContain("2 page image candidates discovered");
    expect(result.usage?.page_image_candidates).toBe(2);
  });
});
