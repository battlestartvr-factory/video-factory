import { CONTENT_LIMITS } from "@/lib/agent/config";
import { htmlToText } from "@/lib/knowledge/extraction";
import { truncateText } from "@/lib/agent/redaction";
import { validateWebFetchUrl, type DnsLookupFn } from "./url-safety";
import { domainFromUrl, type WebDocument, type WebFetchProvider, WebToolError } from "./types";

export function createWebFetchProvider(lookup?: DnsLookupFn): WebFetchProvider {
  return {
    async fetch(url: string): Promise<WebDocument> {
      let current = await validateWebFetchUrl(url, lookup);
      let response: Response | null = null;

      for (let hop = 0; hop <= CONTENT_LIMITS.maxWebFetchRedirects; hop += 1) {
        response = await globalThis.fetch(current.toString(), {
          method: "GET",
          redirect: "manual",
          headers: {
            "User-Agent": "AI-Content-Factory-Agent/1.0",
            Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1",
          },
          signal: AbortSignal.timeout(CONTENT_LIMITS.webFetchTimeoutMs),
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) {
            throw new WebToolError("WEB_FETCH_FAILED", "Redirect without location");
          }
          const nextRaw = new URL(location, current).toString();
          current = await validateWebFetchUrl(nextRaw, lookup);
          continue;
        }
        break;
      }

      if (!response) {
        throw new WebToolError("WEB_FETCH_FAILED", "Empty fetch response");
      }
      if (!response.ok) {
        throw new WebToolError("WEB_FETCH_FAILED", `Fetch returned ${response.status}`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (
        contentType &&
        !contentType.includes("text/") &&
        !contentType.includes("json") &&
        !contentType.includes("xml") &&
        !contentType.includes("html")
      ) {
        throw new WebToolError("WEB_FETCH_FAILED", "Unsupported content type");
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > CONTENT_LIMITS.maxWebFetchBytes) {
        throw new WebToolError("WEB_FETCH_FAILED", "Document exceeds size limit");
      }

      const raw = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
      const text = contentType.includes("html") ? htmlToText(raw) : raw.replace(/\s+/g, " ").trim();
      const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

      return {
        url: current.toString(),
        title: titleMatch?.[1]?.replace(/\s+/g, " ").trim() || current.hostname,
        domain: domainFromUrl(current.toString()),
        text: truncateText(text, CONTENT_LIMITS.maxWebFetchChars),
      };
    },
  };
}
