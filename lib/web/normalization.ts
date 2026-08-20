import { createHash } from "node:crypto";

const TRACKING_QUERY_KEYS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
]);

function isTrackingQueryKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.startsWith("utm_") || TRACKING_QUERY_KEYS.has(normalized);
}

export function canonicalizeWebUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();

  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }

  const params = [...url.searchParams.entries()]
    .filter(([key]) => !isTrackingQueryKey(key))
    .sort(([keyA, valueA], [keyB, valueB]) => keyA.localeCompare(keyB) || valueA.localeCompare(valueB));
  url.search = "";
  for (const [key, value] of params) url.searchParams.append(key, value);

  // Do not collapse a path's trailing slash: servers are allowed to treat `/game`
  // and `/game/` as distinct resources. Canonicalization removes transport noise,
  // not source semantics.
  return url.toString();
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function urlSha256(raw: string): string {
  return sha256Hex(canonicalizeWebUrl(raw));
}

export function normalizeTextForHash(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function textContentSha256(text: string): string {
  return sha256Hex(normalizeTextForHash(text));
}

export function normalizeDomainList(domains?: string[]): string[] | undefined {
  if (!domains?.length) return undefined;
  const normalized = domains
    .map((domain) => domain.trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);
  return [...new Set(normalized)].sort();
}

export function domainMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const target = domain.toLowerCase().replace(/^www\./, "");
  return host === target || host.endsWith(`.${target}`);
}

export function isDomainAllowed(
  hostname: string,
  allowlist?: string[],
  denylist?: string[],
): boolean {
  const allowed = normalizeDomainList(allowlist);
  const denied = normalizeDomainList(denylist);
  if (denied?.some((domain) => domainMatches(hostname, domain))) return false;
  if (allowed?.length && !allowed.some((domain) => domainMatches(hostname, domain))) return false;
  return true;
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 24);
}

/**
 * Returns a bounded excerpt while preferring paragraphs that overlap the research query.
 * External text is returned verbatim (apart from whitespace compaction); it is never
 * interpreted as instructions by this helper.
 */
export function selectQueryRelevantExcerpt(text: string, query: string, maxChars: number): string {
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized || maxChars <= 0) return "";
  if (normalized.length <= maxChars) return normalized;

  const terms = queryTerms(query);
  const chunks = normalized
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-ZА-ЯЁ0-9])/u)
    .map((chunk, index) => {
      const compact = chunk.replace(/\s+/g, " ").trim();
      const haystack = compact.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { compact, index, score };
    })
    .filter((chunk) => chunk.compact.length > 0);

  const ranked = [...chunks].sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: typeof chunks = [];
  let length = 0;
  for (const chunk of ranked) {
    if (!chunk.score && selected.length) break;
    const addition = chunk.compact.length + (selected.length ? 2 : 0);
    if (length + addition > maxChars) continue;
    selected.push(chunk);
    length += addition;
  }

  if (!selected.length) return normalized.slice(0, maxChars).trim();
  return selected
    .sort((a, b) => a.index - b.index)
    .map((chunk) => chunk.compact)
    .join("\n\n")
    .slice(0, maxChars)
    .trim();
}
