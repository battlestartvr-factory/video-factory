import { afterEach, describe, expect, it, vi } from "vitest";
import { parseKieGroundedPayloads } from "../../lib/web/kie-grounded-search";
import { InternalKieResearchScoutExecutor } from "../../lib/research-intelligence/kie-research-scout-client";
import { DurableWorkflowError } from "../../lib/orchestrator/retry";

describe("KIE grounded-search provenance hotfix", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps native Gemini grounding metadata as the strongest provenance", () => {
    const parsed = parseKieGroundedPayloads([
      {
        candidates: [
          {
            content: { parts: [{ text: "Grounded answer" }] },
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: "https://example.com/game", title: "Example Game" } },
              ],
              groundingSupports: [
                {
                  segment: { text: "Players cooperate around a shared constraint." },
                  groundingChunkIndices: [0],
                },
              ],
              webSearchQueries: ["co-op shared constraint"],
            },
          },
        ],
      },
    ]);

    expect(parsed.chunks).toHaveLength(1);
    expect(parsed.chunks[0]).toMatchObject({
      url: "https://example.com/game",
      title: "Example Game",
      sourceMode: "native_grounding",
    });
    expect(parsed.chunks[0]?.claims).toContain("Players cooperate around a shared constraint.");
  });

  it("accepts the explicit source ledger when KIE strips native grounding metadata", () => {
    const parsed = parseKieGroundedPayloads([
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  text:
                    "A concise grounded observation.\n" +
                    "SOURCE|https://store.example.com/game|Example Store Page|The game supports cooperative play.",
                },
              ],
            },
          },
        ],
        usageMetadata: { totalTokenCount: 123 },
        credits_consumed: 0.25,
      },
    ]);

    expect(parsed.chunks).toHaveLength(1);
    expect(parsed.chunks[0]).toMatchObject({
      url: "https://store.example.com/game",
      title: "Example Store Page",
      sourceMode: "source_ledger",
    });
    expect(parsed.chunks[0]?.claims).toContain("The game supports cooperative play.");
    expect(parsed.usage).toMatchObject({ totalTokenCount: 123, credits_consumed: 0.25 });
  });

  it("accepts provider citation objects from OpenAI-compatible KIE responses", () => {
    const parsed = parseKieGroundedPayloads([
      {
        choices: [
          {
            message: {
              content: "Grounded response",
              annotations: [
                {
                  type: "url_citation",
                  url_citation: {
                    url: "https://example.org/article",
                    title: "Example Article",
                  },
                },
              ],
            },
          },
        ],
      },
    ]);

    expect(parsed.chunks).toHaveLength(1);
    expect(parsed.chunks[0]).toMatchObject({
      url: "https://example.org/article",
      title: "Example Article",
      sourceMode: "provider_citation",
    });
  });

  it("falls back to direct URLs present in the grounded answer", () => {
    const parsed = parseKieGroundedPayloads([
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: "Official page confirms the feature: https://developer.example.net/news/co-op-update",
                },
              ],
            },
          },
        ],
      },
    ]);

    expect(parsed.chunks).toHaveLength(1);
    expect(parsed.chunks[0]).toMatchObject({
      url: "https://developer.example.net/news/co-op-update",
      sourceMode: "answer_url",
    });
  });

  it("never retries a successful-but-unverifiable KIE response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        JSON.stringify({
          ok: false,
          code: "WEB_SEARCH_GROUNDING_MISSING",
          message: "No verifiable source URLs",
        }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      )),
    );

    const executor = new InternalKieResearchScoutExecutor("http://app:3000", "service-key");
    let caught: unknown;
    try {
      await executor.execute({
        jobId: "job-1",
        context: {} as never,
        signal: new AbortController().signal,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DurableWorkflowError);
    expect(caught).toMatchObject({
      code: "WEB_SEARCH_GROUNDING_MISSING",
      retryable: false,
    });
  });
});
