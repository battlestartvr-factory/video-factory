import { CONTENT_LIMITS } from "@/lib/agent/config";
import { htmlToText } from "@/lib/knowledge/extraction";
import { truncateText } from "@/lib/agent/redaction";
import { readImageDimensions, sniffImageMime } from "./image-metadata";
import { canonicalizeWebUrl, sha256Hex, textContentSha256, urlSha256 } from "./normalization";
import { extractPageImageCandidates } from "./page-images";
import { validateWebFetchUrl, type DnsLookupFn } from "./url-safety";
import {
  domainFromUrl,
  type WebDocument,
  type WebFetchProvider,
  type WebImage,
  WebToolError,
} from "./types";

const PAGE_MIME_PREFIXES = ["text/", "application/json", "application/xml", "application/xhtml+xml"];
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function normalizedMime(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

function pageMimeAllowed(contentType: string): boolean {
  if (!contentType) return true;
  if (contentType.endsWith("+xml")) return true;
  return PAGE_MIME_PREFIXES.some((allowed) =>
    allowed.endsWith("/") ? contentType.startsWith(allowed) : contentType === allowed,
  );
}

function stripActiveHtmlContainers(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<form\b[\s\S]*?<\/form\s*>/gi, " ")
    .replace(/<(?:input|button|textarea|select|option|iframe|object|embed)\b[^>]*>/gi, " ");
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(CONTENT_LIMITS.webFetchTimeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declared = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new WebToolError("WEB_FETCH_TOO_LARGE", "Response exceeds size limit");
    }
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new WebToolError("WEB_FETCH_TOO_LARGE", "Response exceeds size limit");
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("size limit exceeded");
        throw new WebToolError("WEB_FETCH_TOO_LARGE", "Response exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function fetchFollowingSafeRedirects(
  rawUrl: string,
  accept: string,
  lookup?: DnsLookupFn,
  signal?: AbortSignal,
): Promise<{ response: Response; finalUrl: URL }> {
  let current = await validateWebFetchUrl(rawUrl, lookup);

  for (let hop = 0; hop <= CONTENT_LIMITS.maxWebFetchRedirects; hop += 1) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const response = await globalThis.fetch(current.toString(), {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": "AI-Content-Factory-Research/1.0",
        Accept: accept,
      },
      signal: requestSignal(signal),
    });

    if (response.status < 300 || response.status >= 400) return { response, finalUrl: current };
    if (hop >= CONTENT_LIMITS.maxWebFetchRedirects) {
      throw new WebToolError("WEB_FETCH_TOO_MANY_REDIRECTS", "Redirect limit exceeded");
    }
    const location = response.headers.get("location");
    if (!location) throw new WebToolError("WEB_FETCH_FAILED", "Redirect without location");
    current = await validateWebFetchUrl(new URL(location, current).toString(), lookup);
  }

  throw new WebToolError("WEB_FETCH_TOO_MANY_REDIRECTS", "Redirect limit exceeded");
}

async function fetchPage(url: string, lookup?: DnsLookupFn, signal?: AbortSignal): Promise<WebDocument> {
  const { response, finalUrl } = await fetchFollowingSafeRedirects(
    url,
    "text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1",
    lookup,
    signal,
  );
  if (!response.ok) throw new WebToolError("WEB_FETCH_FAILED", `Fetch returned ${response.status}`);

  const contentType = normalizedMime(response.headers.get("content-type"));
  if (!pageMimeAllowed(contentType)) {
    throw new WebToolError("WEB_FETCH_UNSUPPORTED_MIME", `Unsupported page content type: ${contentType || "unknown"}`);
  }

  const bytes = await readBoundedResponseBytes(response, CONTENT_LIMITS.maxWebFetchBytes);
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const isHtml = contentType.includes("html") || (!contentType && /<html|<!doctype/i.test(raw));
  const safeHtml = isHtml ? stripActiveHtmlContainers(raw) : raw;
  const extracted = isHtml ? htmlToText(safeHtml) : safeHtml.replace(/\s+/g, " ").trim();
  const text = truncateText(extracted, CONTENT_LIMITS.maxWebFetchChars);
  const titleMatch = isHtml ? safeHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i) : null;
  const canonicalUrl = canonicalizeWebUrl(finalUrl.toString());
  const now = new Date().toISOString();
  const imageCandidates = isHtml ? extractPageImageCandidates(safeHtml, finalUrl) : [];

  return {
    url: finalUrl.toString(),
    canonicalUrl,
    title: titleMatch?.[1]?.replace(/\s+/g, " ").trim() || finalUrl.hostname,
    domain: domainFromUrl(canonicalUrl),
    text,
    observedAt: now,
    fetchedAt: now,
    contentType: contentType || (isHtml ? "text/html" : "text/plain"),
    byteLength: bytes.byteLength,
    urlSha256: urlSha256(canonicalUrl),
    contentSha256: textContentSha256(extracted),
    imageCandidates,
  };
}

async function fetchImage(url: string, lookup?: DnsLookupFn, signal?: AbortSignal): Promise<WebImage> {
  const { response, finalUrl } = await fetchFollowingSafeRedirects(
    url,
    "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1",
    lookup,
    signal,
  );
  if (!response.ok) throw new WebToolError("WEB_FETCH_FAILED", `Image fetch returned ${response.status}`);

  const declaredMime = normalizedMime(response.headers.get("content-type"));
  if (!IMAGE_MIME_TYPES.has(declaredMime)) {
    throw new WebToolError(
      "WEB_FETCH_UNSUPPORTED_MIME",
      `Unsupported image content type: ${declaredMime || "unknown"}`,
    );
  }

  const bytes = await readBoundedResponseBytes(response, CONTENT_LIMITS.maxWebImageBytes);
  const sniffedMime = sniffImageMime(bytes);
  if (!sniffedMime || sniffedMime !== declaredMime) {
    throw new WebToolError("WEB_FETCH_INVALID_IMAGE", "Image bytes do not match the declared image MIME type");
  }

  const dimensions = readImageDimensions(bytes, sniffedMime);
  if (!dimensions) throw new WebToolError("WEB_FETCH_INVALID_IMAGE", "Unable to read image dimensions");
  if (
    dimensions.width > CONTENT_LIMITS.maxWebImageDimension ||
    dimensions.height > CONTENT_LIMITS.maxWebImageDimension ||
    dimensions.width * dimensions.height > CONTENT_LIMITS.maxWebImagePixels
  ) {
    throw new WebToolError("WEB_FETCH_IMAGE_DIMENSIONS_EXCEEDED", "Image dimensions exceed safety limits");
  }

  const canonicalUrl = canonicalizeWebUrl(finalUrl.toString());
  const now = new Date().toISOString();
  return {
    url: finalUrl.toString(),
    canonicalUrl,
    domain: domainFromUrl(canonicalUrl),
    mimeType: sniffedMime,
    width: dimensions.width,
    height: dimensions.height,
    byteLength: bytes.byteLength,
    contentSha256: sha256Hex(bytes),
    urlSha256: urlSha256(canonicalUrl),
    observedAt: now,
    fetchedAt: now,
    bytes,
  };
}

export function createWebFetchProvider(lookup?: DnsLookupFn, signal?: AbortSignal): WebFetchProvider {
  return {
    fetch(url: string) {
      return fetchPage(url, lookup, signal);
    },
    fetchPage(url: string) {
      return fetchPage(url, lookup, signal);
    },
    fetchImage(url: string) {
      return fetchImage(url, lookup, signal);
    },
  };
}
