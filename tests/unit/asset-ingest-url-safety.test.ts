import { describe, expect, it } from "vitest";
import {
  assertSafeSourceUrl,
  hostMatchesAllowed,
  isBlockedIp,
  validateSourceUrlForIngest,
} from "@/lib/asset-ingest/url-safety";
import { IngestError } from "@/lib/asset-ingest/types";

describe("asset-ingest url safety", () => {
  it("accepts exact allowed hostname", () => {
    expect(
      hostMatchesAllowed("file.aiquickdraw.com", ["file.aiquickdraw.com"]),
    ).toBe(true);
  });

  it("accepts wildcard subdomain hosts", () => {
    expect(
      hostMatchesAllowed("cdn.example.com", ["*.example.com"]),
    ).toBe(true);
    expect(hostMatchesAllowed("example.com", ["*.example.com"])).toBe(false);
  });

  it("rejects forbidden hostname", async () => {
    await expect(
      validateSourceUrlForIngest("https://evil.example/x", ["file.aiquickdraw.com"], async () => [
        { address: "1.2.3.4", family: 4 },
      ]),
    ).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED" });
  });

  it("rejects non-https and credentials", () => {
    expect(() => assertSafeSourceUrl("http://file.aiquickdraw.com/a")).toThrow(
      IngestError,
    );
    expect(() =>
      assertSafeSourceUrl("https://user:pass@file.aiquickdraw.com/a"),
    ).toThrow(IngestError);
  });

  it("rejects IP address hostnames", () => {
    expect(() => assertSafeSourceUrl("https://127.0.0.1/a")).toThrow(IngestError);
    expect(() => assertSafeSourceUrl("https://[::1]/a")).toThrow(IngestError);
  });

  it("flags private IPv4 and IPv6 ranges", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("10.0.0.5")).toBe(true);
    expect(isBlockedIp("192.168.1.1")).toBe(true);
    expect(isBlockedIp("172.16.0.1")).toBe(true);
    expect(isBlockedIp("169.254.1.1")).toBe(true);
    expect(isBlockedIp("224.0.0.1")).toBe(true);
    expect(isBlockedIp("8.8.8.8")).toBe(false);

    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("fc00::1")).toBe(true);
    expect(isBlockedIp("fe80::1")).toBe(true);
    expect(isBlockedIp("ff02::1")).toBe(true);
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("2001:4860:4860::8888")).toBe(false);
  });

  it("rejects DNS answers in private ranges", async () => {
    await expect(
      validateSourceUrlForIngest(
        "https://file.aiquickdraw.com/a",
        ["file.aiquickdraw.com"],
        async () => [{ address: "10.1.2.3", family: 4 }],
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_URL" });

    await expect(
      validateSourceUrlForIngest(
        "https://file.aiquickdraw.com/a",
        ["file.aiquickdraw.com"],
        async () => [{ address: "fc00::abcd", family: 6 }],
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_URL" });
  });
});
