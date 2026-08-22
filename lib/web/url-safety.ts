import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { isBlockedIp } from "../asset-ingest/url-safety";

export type DnsLookupFn = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export class WebUrlError extends Error {
  constructor(
    public readonly code: "WEB_FETCH_UNSAFE_URL" | "WEB_FETCH_BLOCKED_HOST",
    message = "Unsafe URL",
  ) {
    super(message);
    this.name = "WebUrlError";
  }
}

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "metadata.internal",
]);

const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".corp"];

function defaultDnsLookup(hostname: string) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

export function assertSafeWebUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebUrlError("WEB_FETCH_UNSAFE_URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WebUrlError("WEB_FETCH_UNSAFE_URL");
  }

  if (url.username || url.password) {
    throw new WebUrlError("WEB_FETCH_UNSAFE_URL");
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname) throw new WebUrlError("WEB_FETCH_UNSAFE_URL");
  if (hostname.startsWith("[") || hostname.includes(":")) {
    throw new WebUrlError("WEB_FETCH_UNSAFE_URL");
  }

  if (isIP(hostname) !== 0) {
    if (isBlockedIp(hostname)) throw new WebUrlError("WEB_FETCH_UNSAFE_URL");
    throw new WebUrlError("WEB_FETCH_UNSAFE_URL");
  }

  if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith(".localhost")) {
    throw new WebUrlError("WEB_FETCH_BLOCKED_HOST");
  }
  if (BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new WebUrlError("WEB_FETCH_BLOCKED_HOST");
  }

  return url;
}

export async function assertPublicWebHost(
  hostname: string,
  lookup: DnsLookupFn = defaultDnsLookup,
): Promise<Array<{ address: string; family: number }>> {
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(hostname);
  } catch {
    throw new WebUrlError("WEB_FETCH_UNSAFE_URL");
  }
  if (!records.length) throw new WebUrlError("WEB_FETCH_UNSAFE_URL");
  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new WebUrlError("WEB_FETCH_UNSAFE_URL");
    }
  }
  return records;
}

export async function validateWebFetchUrl(
  raw: string,
  lookup?: DnsLookupFn,
): Promise<URL> {
  const url = assertSafeWebUrl(raw);
  await assertPublicWebHost(url.hostname, lookup);
  return url;
}
