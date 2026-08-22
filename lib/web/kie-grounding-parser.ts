import { canonicalizeWebUrl } from "./normalization";
import { WebToolError } from "./types";

type GroundingSourceMode =
  | "native_grounding"
  | "provider_citation"
  | "source_ledger"
  | "answer_url";

interface GroundedChunk {
  title: string;
  url: string;
  claims: string[];
  index: number;
  sourceMode: GroundingSourceMode;
}

interface KieGroundedResponse {
  answer: string;
  chunks: GroundedChunk[];
  webSearchQueries: string[];
  usage: Record<string, unknown>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function completePublicHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized === "localhost" || !normalized.includes(".")) return false;
  if (normalized === "vertexaisearch" || normalized === "vertexaisearch.cloud.google") return false;
  const labels = normalized.split(".");
  if (labels.some((label) => !label || !/^[a-z0-9-]+$/i.test(label))) return false;
  const tld = labels.at(-1) ?? "";
  return /^[a-z]{2,63}$/i.test(tld) || /^xn--[a-z0-9-]{2,59}$/i.test(tld);
}

function safeCanonicalUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!completePublicHostname(parsed.hostname)) return null;
    return canonicalizeWebUrl(parsed.toString());
  } catch {
    return null;
  }
}

function isGoogleGroundingRedirect(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.hostname.toLowerCase().replace(/\.$/, "") === "vertexaisearch.cloud.google.com"
      && parsed.pathname.startsWith("/grounding-api-redirect/");
  } catch {
    return false;
  }
}

function normalizeGroundingMetadata(candidate: Record<string, unknown>): Record<string, unknown> {
  return object(candidate.groundingMetadata ?? candidate.grounding_metadata);
}

function sourceModePriority(mode: GroundingSourceMode): number {
  switch (mode) {
    case "native_grounding": return 4;
    case "provider_citation": return 3;
    case "source_ledger": return 2;
    case "answer_url": return 1;
  }
}

function upsertChunk(
  chunksByUrl: Map<string, GroundedChunk>,
  input: {
    rawUrl: string;
    title?: string;
    claim?: string;
    index?: number;
    sourceMode: GroundingSourceMode;
  },
): string | null {
  const canonicalUrl = safeCanonicalUrl(input.rawUrl);
  if (!canonicalUrl) return null;
  if (
    isGoogleGroundingRedirect(canonicalUrl)
    && (input.sourceMode === "answer_url" || input.sourceMode === "source_ledger")
  ) {
    return null;
  }
  const existing = chunksByUrl.get(canonicalUrl);
  if (existing) {
    if (input.title && existing.title === existing.url) existing.title = input.title.slice(0, 500);
    if (input.claim && !existing.claims.includes(input.claim)) existing.claims.push(input.claim);
    if (sourceModePriority(input.sourceMode) > sourceModePriority(existing.sourceMode)) {
      existing.sourceMode = input.sourceMode;
    }
    return canonicalUrl;
  }
  chunksByUrl.set(canonicalUrl, {
    title: input.title?.slice(0, 500) || canonicalUrl,
    url: canonicalUrl,
    claims: input.claim ? [input.claim] : [],
    index: input.index ?? chunksByUrl.size,
    sourceMode: input.sourceMode,
  });
  return canonicalUrl;
}

function extractHttpUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"'`|]+/gi) ?? [];
  const output: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const trimmed = match.replace(/[\])},.;!?]+$/g, "");
    const canonical = safeCanonicalUrl(trimmed);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    output.push(canonical);
  }
  return output;
}

function collectStructuredCitationUrls(
  value: unknown,
  chunksByUrl: Map<string, GroundedChunk>,
  path: string[] = [],
  depth = 0,
): void {
  if (depth > 10) return;
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredCitationUrls(item, chunksByUrl, path, depth + 1);
    return;
  }
  const record = object(value);
  if (Object.keys(record).length === 0) return;

  const context = path.join(".").toLowerCase();
  const sourceLikeContext = /(ground|citation|source|annotation|search.?result|web.?result|reference)/.test(context);
  if (sourceLikeContext) {
    const rawUrl = string(record.url ?? record.uri ?? record.href ?? record.link);
    if (rawUrl) {
      upsertChunk(chunksByUrl, {
        rawUrl,
        title: string(record.title ?? record.name),
        claim: string(record.claim ?? record.snippet ?? record.description ?? record.text),
        sourceMode: "provider_citation",
      });
    }
  }

  for (const [key, child] of Object.entries(record)) {
    collectStructuredCitationUrls(child, chunksByUrl, [...path, key], depth + 1);
  }
}

function parseSourceLedger(answer: string, chunksByUrl: Map<string, GroundedChunk>): void {
  for (const line of answer.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:SOURCE|SOURCE_URL|CITATION)\s*[|:]\s*(https?:\/\/[^\s|]+)(?:\s*\|\s*([^|]*))?(?:\s*\|\s*(.*))?$/i,
    );
    if (!match) continue;
    upsertChunk(chunksByUrl, {
      rawUrl: match[1],
      title: match[2]?.trim() || undefined,
      claim: match[3]?.trim() || undefined,
      sourceMode: "source_ledger",
    });
  }
}

function parseAnswerUrls(answer: string, chunksByUrl: Map<string, GroundedChunk>): void {
  for (const line of answer.split(/\r?\n/)) {
    const urls = extractHttpUrls(line);
    for (const url of urls) {
      const claim = line
        .replace(url, "")
        .replace(/^\s*[-*\d.)\]]+\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
      upsertChunk(chunksByUrl, {
        rawUrl: url,
        claim: claim.length >= 12 ? claim.slice(0, 4_000) : undefined,
        sourceMode: "answer_url",
      });
    }
  }
}

function appendStreamingText(current: string, next: string | undefined): string {
  if (!next) return current;
  if (!current) return next;
  if (next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;
  const maxOverlap = Math.min(current.length, next.length, 1_024);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (current.endsWith(next.slice(0, overlap))) return current + next.slice(overlap);
  }
  return current + next;
}

function collectOpenAiAnswer(root: Record<string, unknown>, append: (text?: string) => void): void {
  for (const choiceValue of array(root.choices)) {
    const choice = object(choiceValue);
    for (const message of [object(choice.message), object(choice.delta)]) {
      const content = message.content;
      append(string(content));
      for (const partValue of array(content)) {
        const part = object(partValue);
        append(string(part.text ?? part.content));
      }
    }
  }
}

export function parseKieGroundedPayloads(payloads: unknown[]): KieGroundedResponse {
  let answer = "";
  const appendAnswer = (text?: string) => {
    answer = appendStreamingText(answer, text);
  };
  const chunksByUrl = new Map<string, GroundedChunk>();
  const webSearchQueries = new Set<string>();
  let usage: Record<string, unknown> = {};

  for (const payload of payloads) {
    const root = object(payload);
    usage = {
      ...usage,
      ...object(root.usageMetadata ?? root.usage_metadata ?? root.usage),
      ...(typeof root.credits_consumed === "number" ? { credits_consumed: root.credits_consumed } : {}),
    };
    collectOpenAiAnswer(root, appendAnswer);
    collectStructuredCitationUrls(root, chunksByUrl);

    for (const candidateValue of array(root.candidates)) {
      const candidate = object(candidateValue);
      const content = object(candidate.content);
      for (const partValue of array(content.parts)) {
        appendAnswer(string(object(partValue).text));
      }

      const grounding = normalizeGroundingMetadata(candidate);
      const localChunkIndexToUrl = new Map<number, string>();
      const rawChunks = array(grounding.groundingChunks ?? grounding.grounding_chunks);
      for (const [index, rawChunk] of rawChunks.entries()) {
        const web = object(object(rawChunk).web);
        const rawUrl = string(web.uri ?? web.url);
        if (!rawUrl) continue;
        const canonicalUrl = upsertChunk(chunksByUrl, {
          rawUrl,
          title: string(web.title),
          index,
          sourceMode: "native_grounding",
        });
        if (canonicalUrl) localChunkIndexToUrl.set(index, canonicalUrl);
      }

      for (const query of array(grounding.webSearchQueries ?? grounding.web_search_queries)) {
        const value = string(query);
        if (value) webSearchQueries.add(value);
      }

      for (const supportValue of array(grounding.groundingSupports ?? grounding.grounding_supports)) {
        const support = object(supportValue);
        const segment = object(support.segment);
        const claim = string(segment.text);
        if (!claim) continue;
        const indices = array(support.groundingChunkIndices ?? support.grounding_chunk_indices)
          .map((value) => typeof value === "number" ? value : Number(value))
          .filter((value) => Number.isInteger(value) && value >= 0);
        for (const index of indices) {
          const url = localChunkIndexToUrl.get(index);
          if (!url) continue;
          const chunk = chunksByUrl.get(url);
          if (chunk && !chunk.claims.includes(claim)) chunk.claims.push(claim);
        }
      }
    }
  }

  answer = answer.trim();
  parseSourceLedger(answer, chunksByUrl);
  parseAnswerUrls(answer, chunksByUrl);

  return {
    answer,
    chunks: [...chunksByUrl.values()],
    webSearchQueries: [...webSearchQueries],
    usage,
  };
}

function parseProviderBody(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith("data:") && !trimmed.startsWith("event:")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new WebToolError("WEB_SEARCH_INVALID_RESPONSE", "KIE Gemini returned invalid JSON");
    }
  }

  const payloads: unknown[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      payloads.push(JSON.parse(data) as unknown);
    } catch {
      // Ignore one malformed stream chunk; the source-provenance contract fails closed downstream.
    }
  }
  return payloads;
}

export async function readKieProviderPayloads(response: Response): Promise<unknown[]> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    return parseProviderBody(await response.text());
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const payloads: unknown[] = [];
  let buffer = "";
  let eventData: string[] = [];

  const flushEvent = () => {
    if (eventData.length === 0) return;
    const data = eventData.join("\n").trim();
    eventData = [];
    if (!data || data === "[DONE]") return;
    try {
      payloads.push(JSON.parse(data) as unknown);
    } catch {
      // Ignore one malformed stream event; the grounding contract fails closed downstream.
    }
  };

  const consumeLine = (rawLine: string) => {
    const line = rawLine.replace(/\r$/, "");
    if (line === "") {
      flushEvent();
      return;
    }
    if (line.startsWith(":")) return;
    const normalized = line.trimStart();
    if (!normalized.startsWith("data:")) return;
    eventData.push(normalized.slice(5).trimStart());
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      consumeLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer) consumeLine(buffer);
  flushEvent();
  return payloads;
}
