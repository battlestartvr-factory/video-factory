import {
  parseKieGroundedPayloads,
  readKieProviderPayloads,
} from "../web/kie-grounding-parser";
import { isDomainAllowed } from "../web/normalization";
import {
  domainFromUrl,
  type SearchOptions,
  type SearchResult,
  type TextSearchRequest,
  WebToolError,
} from "../web/types";

type GroundedRequestMode = "primary" | "provenance_recovery";
type ParsedGroundedResponse = ReturnType<typeof parseKieGroundedPayloads>;

interface GroundedAttempt {
  parsed: ParsedGroundedResponse;
  diagnostics: Record<string, unknown>;
}

export interface SharedPoolKieSearchProviderOptions {
  allowProvenanceRecovery?: boolean;
}

const PRIMARY_MAX_OUTPUT_TOKENS = 8_192;
const RECOVERY_MAX_OUTPUT_TOKENS = 768;
const SEARCH_THINKING_LEVEL = "minimal" as const;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedMaxResults(maxResults?: number): number {
  const value = Number.isFinite(maxResults) ? Math.trunc(maxResults as number) : 10;
  return Math.max(1, Math.min(10, value));
}

function normalizeKieBaseUrl(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "https://api.kie.ai";
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname === "api.kie.ai" || parsed.hostname.endsWith(".kie.ai")) {
      return `${parsed.protocol}//${parsed.host}`;
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

function freshnessInstruction(value?: SearchOptions["freshness"]): string {
  if (value === "current") return "Prefer current sources when the claim is time-sensitive.";
  if (value === "recent") return "Prefer recent sources, retaining durable primary sources when useful.";
  if (value === "evergreen") return "Prefer authoritative durable sources; recency is not required.";
  return "Use a mix of recent and authoritative durable sources.";
}

function domainInstruction(input: SearchOptions): string {
  const allow = input.domainAllowlist?.map((item) => item.trim()).filter(Boolean) ?? [];
  const deny = input.domainDenylist?.map((item) => item.trim()).filter(Boolean) ?? [];
  return [
    allow.length ? `Restrict to these domains when possible: ${allow.join(", ")}.` : "",
    deny.length ? `Do not use these domains: ${deny.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
}

function sourceReliabilityInstruction(query: string): string {
  const normalized = query.toLowerCase();
  const instructions = [
    "Production Safe Fetch only accepts direct public pages. Never return vertexaisearch.cloud.google.com grounding redirect URLs.",
  ];

  if (/player_voice|player-authored|player authored|community discussion|user review/.test(normalized)) {
    instructions.push(
      "For player-authored evidence, Reddit is NOT usable by production Safe Fetch because it returns HTTP 403. Do not return reddit.com URLs.",
      "Prefer direct Steam Community review/discussion pages first (steamcommunity.com/app/<id>/reviews or /discussions), then other normal public forums that are readable without login or anti-bot challenges.",
      "Return at least two distinct Safe-Fetchable player-authored pages when possible; do not substitute press reviews, YouTube reviews, store ratings, or editorial summaries.",
    );
  }

  if (/gameplay_visual|gameplay visual|gameplay footage|real gameplay|camera\/readability/.test(normalized)) {
    instructions.push(
      "For gameplay evidence, prefer direct YouTube watch URLs, Steam Community videos/screenshots, or official pages with real in-game footage/screenshots. Avoid search-result pages and key-art-only marketing pages.",
    );
  }

  return instructions.join("\n");
}

function buildPrompt(input: TextSearchRequest, mode: GroundedRequestMode): string {
  const maxResults = mode === "provenance_recovery"
    ? Math.min(4, boundedMaxResults(input.maxResults))
    : boundedMaxResults(input.maxResults);
  return [
    "Use Google Search grounding. This is source acquisition, not design analysis. Do not spend tokens reasoning about game concepts.",
    `Research query: ${input.query.trim()}`,
    `Return at most ${maxResults} verified direct source lines and nothing else.`,
    "Each line must be exactly: SOURCE|<direct final https URL>|<short title>|<one short factual claim supported by that source>.",
    "DIVERSITY IS REQUIRED: do not fill the set with store pages. When the query needs broad discovery, aim to include evidence from multiple source families: official/store/developer; mechanics or developer documentation/interviews; player reviews/community discussion; real gameplay/video/screenshots or gameplay descriptions; critical/comparison/counterexample material.",
    "For a broad four-source request, prioritize one Safe-Fetchable source for each core purpose: competitor, mechanics, player-authored voice, and real gameplay/visual evidence.",
    "Prefer independent source domains and different evidence purposes. Two URLs that resolve to the same page or repeat the same fact are not diverse.",
    "Player sentiment requires actual player/review/community evidence; a store rating alone is not a player-voice substitute. Gameplay/visual evidence must describe or show real play, not only key art or marketing copy.",
    "Never invent, shorten, truncate, or guess a URL. Never return Google grounding redirect URLs when a direct final URL is available. Omit any source whose direct final URL cannot be verified.",
    sourceReliabilityInstruction(input.query),
    freshnessInstruction(input.freshness),
    domainInstruction(input),
  ].filter(Boolean).join("\n");
}

export function buildSharedPoolKieRequestBody(
  input: TextSearchRequest,
  mode: GroundedRequestMode = "primary",
): Record<string, unknown> {
  return {
    stream: true,
    contents: [{ role: "user", parts: [{ text: buildPrompt(input, mode) }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: {
      maxOutputTokens: mode === "provenance_recovery"
        ? RECOVERY_MAX_OUTPUT_TOKENS
        : PRIMARY_MAX_OUTPUT_TOKENS,
      thinkingConfig: {
        includeThoughts: false,
        thinkingLevel: SEARCH_THINKING_LEVEL,
      },
    },
  };
}

function responseDiagnostics(
  payloads: unknown[],
  parsed: ParsedGroundedResponse,
): Record<string, unknown> {
  let candidateCount = 0;
  const finishReasons = new Set<string>();
  for (const payload of payloads) {
    const root = object(payload);
    const candidates = array(root.candidates);
    const choices = array(root.choices);
    candidateCount += candidates.length + choices.length;
    for (const value of [...candidates, ...choices]) {
      const item = object(value);
      const reason = string(item.finishReason ?? item.finish_reason);
      if (reason) finishReasons.add(reason);
    }
  }
  return {
    payload_count: payloads.length,
    candidate_count: candidateCount,
    finish_reasons: [...finishReasons].slice(0, 8),
    answer_chars: parsed.answer.length,
    grounding_chunk_count: parsed.chunks.length,
    web_search_query_count: parsed.webSearchQueries.length,
  };
}

function mergeProviderUsage(
  primary: Record<string, unknown>,
  recovery?: Record<string, unknown>,
): Record<string, unknown> {
  if (!recovery) return { ...primary, provider_calls: 1, provenance_recovery_used: false };
  const merged: Record<string, unknown> = { ...primary };
  for (const [key, value] of Object.entries(recovery)) {
    if (typeof value === "number" && typeof merged[key] === "number") {
      merged[key] = Number(merged[key]) + value;
    } else if (!(key in merged)) {
      merged[key] = value;
    } else {
      merged[`recovery_${key}`] = value;
    }
  }
  return {
    ...merged,
    provider_calls: 2,
    provenance_recovery_used: true,
  };
}

function usageWithDiagnostics(
  primary: GroundedAttempt,
  recovery?: GroundedAttempt,
): Record<string, unknown> {
  return {
    ...mergeProviderUsage(primary.parsed.usage, recovery?.parsed.usage),
    thinking_level: SEARCH_THINKING_LEVEL,
    include_thoughts: false,
    response_diagnostics: {
      primary: primary.diagnostics,
      ...(recovery ? { recovery: recovery.diagnostics } : {}),
    },
  };
}

function groundingMissingError(input: {
  message: string;
  primary: GroundedAttempt;
  recovery?: GroundedAttempt;
}): WebToolError & { usage?: Record<string, unknown> } {
  const error = new WebToolError("WEB_SEARCH_GROUNDING_MISSING", input.message) as WebToolError & {
    usage?: Record<string, unknown>;
  };
  error.usage = {
    ...usageWithDiagnostics(input.primary, input.recovery),
    failure_diagnostics: {
      primary: input.primary.diagnostics,
      ...(input.recovery ? { recovery: input.recovery.diagnostics } : {}),
    },
  };
  return error;
}

function groundedSearchSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(45_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class SharedPoolKieSearchProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model = "gemini-3-6-flash",
    private readonly signal?: AbortSignal,
    private readonly options: SharedPoolKieSearchProviderOptions = {},
  ) {}

  private async requestGrounded(
    input: TextSearchRequest,
    mode: GroundedRequestMode,
  ): Promise<GroundedAttempt> {
    if (this.signal?.aborted) throw this.signal.reason ?? new DOMException("Aborted", "AbortError");
    const endpoint = `${this.baseUrl.replace(/\/+$/, "")}/gemini/v1/models/${encodeURIComponent(this.model)}:streamGenerateContent`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "X-Goog-Api-Key": this.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(buildSharedPoolKieRequestBody(input, mode)),
      signal: groundedSearchSignal(this.signal),
    });
    if (!response.ok) {
      throw new WebToolError(
        response.status === 429 ? "WEB_SEARCH_RATE_LIMITED" : "WEB_SEARCH_FAILED",
        `KIE Gemini Google Search returned ${response.status}`,
      );
    }
    const payloads = await readKieProviderPayloads(response);
    const parsed = parseKieGroundedPayloads(payloads);
    return { parsed, diagnostics: responseDiagnostics(payloads, parsed) };
  }

  private async groundedSearch(input: TextSearchRequest): Promise<ParsedGroundedResponse> {
    const primary = await this.requestGrounded(input, "primary");
    if (primary.parsed.chunks.length > 0) {
      return {
        ...primary.parsed,
        usage: usageWithDiagnostics(primary),
      };
    }

    if (!primary.parsed.answer.trim() || this.signal?.aborted) {
      throw groundingMissingError({
        message: "KIE Gemini returned no verifiable source URLs or visible grounded answer",
        primary,
      });
    }

    if (this.options.allowProvenanceRecovery === false) {
      throw groundingMissingError({
        message: "KIE Gemini returned visible text without provenance and provenance recovery is disabled for this bounded search",
        primary,
      });
    }

    const recovery = await this.requestGrounded(input, "provenance_recovery");
    if (recovery.parsed.chunks.length === 0) {
      throw groundingMissingError({
        message: "KIE Gemini provenance recovery returned no verifiable direct source URLs",
        primary,
        recovery,
      });
    }
    return {
      answer: primary.parsed.answer || recovery.parsed.answer,
      chunks: recovery.parsed.chunks,
      webSearchQueries: [...new Set([
        ...primary.parsed.webSearchQueries,
        ...recovery.parsed.webSearchQueries,
      ])],
      usage: usageWithDiagnostics(primary, recovery),
    };
  }

  async searchText(input: TextSearchRequest): Promise<SearchResult[]> {
    const grounded = await this.groundedSearch(input);
    const maxResults = boundedMaxResults(input.maxResults);
    const observedAt = new Date().toISOString();
    const results: SearchResult[] = [];

    for (const chunk of grounded.chunks) {
      const domain = domainFromUrl(chunk.url);
      if (domain === "vertexaisearch.cloud.google.com") continue;
      if (!isDomainAllowed(domain, input.domainAllowlist, input.domainDenylist)) continue;
      results.push({
        title: chunk.title.slice(0, 500),
        url: chunk.url,
        canonicalUrl: chunk.url,
        domain,
        snippet: chunk.claims.join(" ").slice(0, 800) || grounded.answer.slice(0, 800) || undefined,
        observedAt,
        providerMetadata: {
          provider: "kie_gemini_google_search_shared_pool",
          model: this.model,
          groundingChunkIndex: chunk.index,
          groundingSourceMode: chunk.sourceMode,
          groundedClaims: chunk.claims.slice(0, 12),
          webSearchQueries: grounded.webSearchQueries.slice(0, 12),
          provenanceRecoveryUsed: grounded.usage.provenance_recovery_used === true,
          usage: grounded.usage,
        },
      });
      if (results.length >= maxResults) break;
    }
    return results;
  }
}

export function createSharedPoolKieSearchProvider(
  signal?: AbortSignal,
  options: SharedPoolKieSearchProviderOptions = {},
): SharedPoolKieSearchProvider {
  const apiKey = (process.env.KIE_API_KEY ?? process.env.AGENT_LLM_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new WebToolError("WEB_SEARCH_NOT_CONFIGURED", "KIE API key is required for shared-pool grounded search");
  }
  const baseUrl = normalizeKieBaseUrl(process.env.KIE_API_BASE_URL ?? process.env.AGENT_LLM_BASE_URL);
  const model = (process.env.KIE_WEB_SEARCH_MODEL ?? "").trim() || "gemini-3-6-flash";
  return new SharedPoolKieSearchProvider(baseUrl, apiKey, model, signal, options);
}
