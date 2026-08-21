import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSharedPoolKieRequestBody,
  SharedPoolKieSearchProvider,
} from "../../lib/research-intelligence/shared-pool-kie-search";

describe("shared-pool KIE search", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses low thinking without returning thought summaries", () => {
    const body = buildSharedPoolKieRequestBody({
      query: "Find diverse direct co-op sources",
      maxResults: 5,
      freshness: "mixed",
    });
    const generationConfig = body.generationConfig as Record<string, unknown>;

    expect(generationConfig.maxOutputTokens).toBe(768);
    expect(generationConfig.thinkingConfig).toEqual({
      includeThoughts: false,
      thinkingLevel: "low",
    });
    expect(JSON.stringify(body)).toContain("source acquisition, not design analysis");
    expect(JSON.stringify(body)).toContain("DIVERSITY IS REQUIRED");
    expect(JSON.stringify(body)).toContain("SOURCE|");
  });

  it("steers player-voice recovery away from production-blocked Reddit and toward Safe-Fetchable community pages", () => {
    const body = buildSharedPoolKieRequestBody({
      query: "Targeted recovery for player_voice. Need PLAYER-AUTHORED community discussion and user reviews.",
      maxResults: 4,
      freshness: "mixed",
    });
    const serialized = JSON.stringify(body);

    expect(serialized).toContain("Reddit is NOT usable by production Safe Fetch");
    expect(serialized).toContain("Do not return reddit.com URLs");
    expect(serialized).toContain("Steam Community review/discussion pages first");
    expect(serialized).toContain("at least two distinct Safe-Fetchable player-authored pages");
    expect(serialized).toContain("Never return vertexaisearch.cloud.google.com");
  });

  it("requests direct readable gameplay sources for gameplay-visual recovery", () => {
    const body = buildSharedPoolKieRequestBody({
      query: "Targeted gameplay_visual recovery for real gameplay footage and camera readability.",
      maxResults: 4,
      freshness: "mixed",
    });
    const serialized = JSON.stringify(body);

    expect(serialized).toContain("direct YouTube watch URLs");
    expect(serialized).toContain("Steam Community videos/screenshots");
    expect(serialized).toContain("Avoid search-result pages and key-art-only marketing pages");
  });

  it("fails after one paid call on thinking-only/empty-visible output and preserves diagnostics", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        candidates: [
          {
            content: { role: "model", parts: [] },
            finishReason: "MAX_TOKENS",
          },
        ],
        usageMetadata: {
          promptTokenCount: 120,
          thoughtsTokenCount: 90,
          totalTokenCount: 210,
        },
        credits_consumed: 0.02,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new SharedPoolKieSearchProvider(
      "https://api.kie.ai",
      "test-key",
      "gemini-3-6-flash",
      new AbortController().signal,
    );

    let caught: unknown;
    try {
      await provider.searchText({ query: "co-op source acquisition", maxResults: 5 });
    } catch (error) {
      caught = error;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(caught).toMatchObject({
      code: "WEB_SEARCH_GROUNDING_MISSING",
      usage: expect.objectContaining({
        provider_calls: 1,
        provenance_recovery_used: false,
        thinking_level: "low",
        include_thoughts: false,
        promptTokenCount: 120,
        thoughtsTokenCount: 90,
        credits_consumed: 0.02,
        failure_diagnostics: {
          primary: expect.objectContaining({
            candidate_count: 1,
            finish_reasons: ["MAX_TOKENS"],
            answer_chars: 0,
            grounding_chunk_count: 0,
          }),
        },
      }),
    });
  });

  it("allows exactly one compact provenance recovery call when visible text lacks URLs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: "A grounded observation without a visible source URL." }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 100, thoughtsTokenCount: 20, totalTokenCount: 140 },
          credits_consumed: 0.01,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: "SOURCE|https://example.com/game|Example Game|The game supports cooperative play." },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 80, thoughtsTokenCount: 10, totalTokenCount: 110 },
          credits_consumed: 0.01,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new SharedPoolKieSearchProvider(
      "https://api.kie.ai",
      "test-key",
      "gemini-3-6-flash",
      new AbortController().signal,
    );
    const results = await provider.searchText({ query: "co-op source acquisition", maxResults: 5 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      canonicalUrl: "https://example.com/game",
      domain: "example.com",
    });
    expect(results[0]?.providerMetadata?.usage).toMatchObject({
      provider_calls: 2,
      provenance_recovery_used: true,
      thinking_level: "low",
      include_thoughts: false,
      credits_consumed: 0.02,
    });

    const recoveryRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(recoveryRequest.generationConfig).toMatchObject({
      maxOutputTokens: 384,
      thinkingConfig: { includeThoughts: false, thinkingLevel: "low" },
    });
  });
});
