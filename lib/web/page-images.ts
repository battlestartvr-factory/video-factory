import { canonicalizeWebUrl } from "./normalization";

export type WebPageImageCandidateKind = "og_image" | "twitter_image" | "image_src" | "image_srcset";

export interface WebPageImageCandidate {
  url: string;
  canonicalUrl: string;
  kind: WebPageImageCandidateKind;
  alt?: string;
  width?: number;
  height?: number;
}

const MAX_PAGE_IMAGE_CANDIDATES = 32;

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function attribute(tag: string, name: string): string | undefined {
  const expression = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = tag.match(expression);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value ? decodeHtmlAttribute(value.trim()) : undefined;
}

function positiveInteger(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveCandidateUrl(raw: string | undefined, pageUrl: URL): string | null {
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:") || raw.startsWith("javascript:")) return null;
  try {
    const resolved = new URL(raw, pageUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    return canonicalizeWebUrl(resolved.toString());
  } catch {
    return null;
  }
}

function firstSrcsetUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const entries = value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((item): item is string => Boolean(item));
  return entries.at(-1);
}

export function extractPageImageCandidates(html: string, pageUrl: URL): WebPageImageCandidate[] {
  const results: WebPageImageCandidate[] = [];
  const seen = new Set<string>();

  const push = (input: {
    rawUrl?: string;
    kind: WebPageImageCandidateKind;
    alt?: string;
    width?: number;
    height?: number;
  }) => {
    if (results.length >= MAX_PAGE_IMAGE_CANDIDATES) return;
    const canonicalUrl = resolveCandidateUrl(input.rawUrl, pageUrl);
    if (!canonicalUrl || seen.has(canonicalUrl)) return;
    seen.add(canonicalUrl);
    results.push({
      url: canonicalUrl,
      canonicalUrl,
      kind: input.kind,
      ...(input.alt ? { alt: input.alt.slice(0, 500) } : {}),
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
    });
  };

  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const property = (attribute(tag, "property") ?? attribute(tag, "name") ?? "").toLowerCase();
    if (property === "og:image" || property === "og:image:url" || property === "og:image:secure_url") {
      push({ rawUrl: attribute(tag, "content"), kind: "og_image" });
    } else if (property === "twitter:image" || property === "twitter:image:src") {
      push({ rawUrl: attribute(tag, "content"), kind: "twitter_image" });
    }
  }

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const alt = attribute(tag, "alt") ?? attribute(tag, "title");
    const width = positiveInteger(attribute(tag, "width"));
    const height = positiveInteger(attribute(tag, "height"));
    push({ rawUrl: attribute(tag, "src"), kind: "image_src", alt, width, height });
    push({ rawUrl: firstSrcsetUrl(attribute(tag, "srcset")), kind: "image_srcset", alt, width, height });
  }

  return results;
}
