import { promises as dns } from "node:dns";
import { isIP, BlockList } from "node:net";
import { IngestError } from "./types";

export type DnsLookupFn = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

const blocked = new BlockList();

// IPv4 special-use / private / reserved / multicast
blocked.addSubnet("0.0.0.0", 8, "ipv4");
blocked.addSubnet("10.0.0.0", 8, "ipv4");
blocked.addSubnet("100.64.0.0", 10, "ipv4"); // shared address space
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addSubnet("169.254.0.0", 16, "ipv4");
blocked.addSubnet("172.16.0.0", 12, "ipv4");
blocked.addSubnet("192.0.0.0", 24, "ipv4");
blocked.addSubnet("192.0.2.0", 24, "ipv4"); // TEST-NET-1
blocked.addSubnet("192.168.0.0", 16, "ipv4");
blocked.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
blocked.addSubnet("198.51.100.0", 24, "ipv4"); // TEST-NET-2
blocked.addSubnet("203.0.113.0", 24, "ipv4"); // TEST-NET-3
blocked.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
blocked.addSubnet("240.0.0.0", 4, "ipv4"); // reserved
blocked.addAddress("255.255.255.255", "ipv4");

// IPv6 special-use
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6"); // unique local
blocked.addSubnet("fe80::", 10, "ipv6"); // link-local
blocked.addSubnet("ff00::", 8, "ipv6"); // multicast
blocked.addSubnet("2001:db8::", 32, "ipv6"); // documentation

export function isBlockedIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    // IPv4-mapped IPv6 (::ffff:x.x.x.x)
    const lower = address.toLowerCase();
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice("::ffff:".length);
      if (isIP(mapped) === 4) return isBlockedIp(mapped);
    }
    return blocked.check(address, "ipv6");
  }
  return true;
}

export function hostMatchesAllowed(
  hostname: string,
  allowedHosts: string[],
): boolean {
  const host = hostname.toLowerCase();
  for (const entry of allowedHosts) {
    const pattern = entry.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      if (host.endsWith(suffix) && host.length > suffix.length) {
        const prefix = host.slice(0, host.length - suffix.length);
        // reject empty or multi-level abuse via empty label
        if (prefix.length > 0 && !prefix.includes("..")) return true;
      }
    } else if (host === pattern) {
      return true;
    }
  }
  return false;
}

export function assertSafeSourceUrl(sourceUrl: string): URL {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new IngestError("UNSAFE_URL", 400);
  }

  if (url.protocol !== "https:") {
    throw new IngestError("UNSAFE_URL", 400);
  }

  if (url.username || url.password) {
    throw new IngestError("UNSAFE_URL", 400);
  }

  const hostname = url.hostname;
  if (!hostname) {
    throw new IngestError("UNSAFE_URL", 400);
  }

  // Reject IP literals as hostname (must be a DNS name)
  if (isIP(hostname) !== 0) {
    throw new IngestError("UNSAFE_URL", 400);
  }

  // Bracketed IPv6 would already be caught by isIP; also reject empty host
  if (hostname.startsWith("[") || hostname.includes(":")) {
    throw new IngestError("UNSAFE_URL", 400);
  }

  return url;
}

export async function assertPublicDns(
  hostname: string,
  lookup: DnsLookupFn = defaultDnsLookup,
): Promise<Array<{ address: string; family: number }>> {
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(hostname);
  } catch {
    throw new IngestError("UNSAFE_URL", 400);
  }

  if (!records.length) {
    throw new IngestError("UNSAFE_URL", 400);
  }

  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new IngestError("UNSAFE_URL", 400);
    }
  }

  return records;
}

async function defaultDnsLookup(
  hostname: string,
): Promise<Array<{ address: string; family: number }>> {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

export async function validateSourceUrlForIngest(
  sourceUrl: string,
  allowedHosts: string[],
  lookup?: DnsLookupFn,
): Promise<URL> {
  const url = assertSafeSourceUrl(sourceUrl);

  if (!hostMatchesAllowed(url.hostname, allowedHosts)) {
    throw new IngestError("HOST_NOT_ALLOWED", 400);
  }

  await assertPublicDns(url.hostname, lookup);
  return url;
}
