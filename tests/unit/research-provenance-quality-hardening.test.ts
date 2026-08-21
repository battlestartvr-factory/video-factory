import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KieGeminiGroundedSearchProvider,
  type SearchResult,
} from "../../lib/web";
import { parseKieGroundedPayloads } from "../../lib/web/kie-grounded-search";
import {
  KieGroundedResearchScoutExecutor,
  sanitizeGroundedEvidenceClaim,
} from "../../lib/research-intelligence/kie-research-scout";
import type { ResearchScoutJobContext } from "../../lib/research-intelligence/scout-runtime";
import type { ResearchToolbox } from "../../lib/research-intelligence/toolbox";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function context(): ResearchScoutJobContext {
  return {
    researchRunId: "research-quality-1",
    scoutRole: "mechanics",
    assignment: {
      role: "mechanics",
      mandate: "Find mechanically distinct co-op dependency patterns.",
      queryAngles: ["shared systems"],
      freshness: "recent",
      sourcePreferences: [],
      forbiddenOverlap: [],
      imageSearchRequired: false,
      budget: {
        maxSearchQueries: 1,
        maxFetchedSources: 3,
        maxEvidenceItems: 5,
        maxImageCandidates: 0,
        maxModelCalls: 1,
      },
    },
    creativeRunId: "creative-quality-1",
    rootFactoryJobId: "root-quality-1",
    rootCreativeRunId: "root-run-quality-1",
    objectiveId: "objective-quality-1",
    existingReport: null,
  };
}

describe("KIE provenance hardening from production failures", () => {
  it("reassembles a SOURCE ledger URL split across streamed delta payloads without injecting a newline", () => {
    const parsed = parseKieGroundedPayloads([
      { choices: [{ delta: { content: "SOURCE|https://store.steam" } }] },
      { choices: [{ delta: { content: "powered.com/app/123/Test_Game/|Steam|Players coordinate a shared mechanic." } }] },
    ]);

    expect(parsed.chunks).toHaveLength(1);
    expect(parsed.chunks[0]?.url).toContain("store.steampowered.com/app/123/Test_Game");
  });

  it("rejects truncated/generated vertexaisearch URLs but accepts a complete native grounding redirect", () => {
    const malformed = parseKieGroundedPayloads([
      {
        choices: [{
          message: {
            content: [
              "SOURCE|https://vertexaisearch./|bad|This URL was truncated.",
              "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ-partial",
            ].join("\n"),
          },
        }],
      },
    ]);
    expect(malformed.chunks).toEqual([]);

    const native = parseKieGroundedPayloads([
      {
        candidates: [{
          content: { parts: [{ text: "A grounded claim." }] },
          groundingMetadata: {
            groundingChunks: [{
              web: {
                uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFuragPl3sgDhR6yWdNmcVmzaduMXMlmYWB42zL_jr67UBeMCLqaT3K7yserx4nGystW8Doi-2HrVLbPMcpdBg4C5UZ30vJhG1FnT14noKbXLIqdfSi2bGxt0Jux9fNSI6rLVGCKq4bQL-EKmqI7fbyERRPgkx80AXOjqsn01A=",
                title: "Steam source",
              },
            }],
          },
        }],
      },
    ]);
    expect(native.chunks).toHaveLength(1);
    expect(native.chunks[0]?.sourceMode).toBe("native_grounding");
  });

  it("uses exactly one compact provenance-recovery request after a successful ungrounded response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        candidates: [{ content: { parts: [{ text: "Useful research prose was returned, but the proxy exposed no source URLs." }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
      }))
      .mockResolvedValueOnce(jsonResponse({
        candidates: [{
          content: {
            parts: [{
              text: "SOURCE|https://store.steampowered.com/app/1966720/Lethal_Company/|Lethal Company on Steam|The store page identifies the game as online co-op.",
            }],
          },
        }],
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 20 },
      }));
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new KieGeminiGroundedSearchProvider(
      "https://api.kie.ai",
      "test-key",
      "gemini-3-6-flash",
    );
    const results = await provider.searchText({ query: "co-op mechanics", maxResults: 4 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(1);
    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const secondBody = JSON.parse(String(secondInit.body)) as {
      generationConfig?: { maxOutputTokens?: number };
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    };
    expect(secondBody.generationConfig?.maxOutputTokens).toBe(384);
    expect(secondBody.contents?.[0]?.parts?.[0]?.text).toContain("direct final https URL");
    expect(results[0]?.providerMetadata?.provenanceRecoveryUsed).toBe(true);
    expect((results[0]?.providerMetadata?.usage as Record<string, unknown>)?.provider_calls).toBe(2);
  });

  it("fails non-retryably after exactly one provenance recovery when direct sources are still unavailable", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        candidates: [{ content: { parts: [{ text: "First answer without source URLs." }] } }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        candidates: [{ content: { parts: [{ text: "Still no verifiable direct source URL." }] } }],
      }));
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new KieGeminiGroundedSearchProvider(
      "https://api.kie.ai",
      "test-key",
      "gemini-3-6-flash",
    );

    await expect(provider.searchText({ query: "mechanics evidence" })).rejects.toMatchObject({
      code: "WEB_SEARCH_GROUNDING_MISSING",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Research evidence quality gate", () => {
  it("drops source-ledger/punctuation garbage and normalizes useful markdown claims", () => {
    expect(sanitizeGroundedEvidenceClaim("*")).toBeNull();
    expect(sanitizeGroundedEvidenceClaim("SOURCE||PEAK on Steam|PEAK is a co-op game")).toBeNull();
    expect(sanitizeGroundedEvidenceClaim("https://example.com/source")).toBeNull();
    expect(sanitizeGroundedEvidenceClaim(
      "* **Recoverable failure** creates memorable social stories when teammates can rescue one another.",
    )).toBe("Recoverable failure creates memorable social stories when teammates can rescue one another.");
  });

  it("persists only quality claims and exposes the true bounded provider-call count", async () => {
    const result: SearchResult = {
      title: "Steam Example",
      url: "https://store.steampowered.com/app/123/example",
      canonicalUrl: "https://store.steampowered.com/app/123/example",
      domain: "store.steampowered.com",
      providerMetadata: {
        model: "gemini-3-6-flash",
        groundedClaims: [
          "*",
          "SOURCE||broken ledger artifact",
          "* **Shared-object dependency** forces both players to coordinate timing and recover together after mistakes.",
        ],
        usage: {
          provider_calls: 2,
          provenance_recovery_used: true,
        },
      },
    };
    const toolbox = {
      searchText: vi.fn().mockResolvedValue({
        value: [result],
        reusedFromCache: false,
        cacheKey: "search-cache",
        storedAt: "2026-08-21T07:00:00.000Z",
        expiresAt: "2026-08-21T08:00:00.000Z",
      }),
      fetchSource: vi.fn().mockResolvedValue({
        document: {
          url: result.url,
          canonicalUrl: result.url,
          title: result.title,
          domain: result.domain,
          text: "Source body.",
          observedAt: "2026-08-21T07:00:00.000Z",
          urlSha256: "a".repeat(64),
          contentSha256: "b".repeat(64),
          imageCandidates: [],
        },
        evidence: {},
        reusedFromCache: false,
        cacheKey: "source-cache",
      }),
      searchImages: vi.fn(),
      fetchImage: vi.fn(),
    } as unknown as ResearchToolbox;
    const executor = new KieGroundedResearchScoutExecutor(toolbox);

    const execution = await executor.execute({
      jobId: "job-quality-1",
      context: context(),
      signal: new AbortController().signal,
    });

    expect(execution.evidenceBundle?.evidence).toHaveLength(1);
    expect(execution.evidenceBundle?.evidence[0]?.claim).toBe(
      "Shared-object dependency forces both players to coordinate timing and recover together after mistakes.",
    );
    expect(execution.usage?.search_calls).toBe(2);
    expect(execution.usage?.provenance_recovery_used).toBe(true);
  });
});
