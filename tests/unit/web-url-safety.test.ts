import { describe, expect, it } from "vitest";
import { assertSafeWebUrl, WebUrlError, validateWebFetchUrl } from "@/lib/web/url-safety";

describe("web fetch URL safety", () => {
  it("allows public http(s) hostnames", () => {
    expect(assertSafeWebUrl("https://example.com/a").hostname).toBe("example.com");
    expect(assertSafeWebUrl("http://example.com/a").protocol).toBe("http:");
  });

  it("rejects credentials, non-http, localhost and IP literals", () => {
    expect(() => assertSafeWebUrl("ftp://example.com/a")).toThrow(WebUrlError);
    expect(() => assertSafeWebUrl("https://user:pass@example.com/a")).toThrow(WebUrlError);
    expect(() => assertSafeWebUrl("https://localhost/a")).toThrow(WebUrlError);
    expect(() => assertSafeWebUrl("https://127.0.0.1/a")).toThrow(WebUrlError);
    expect(() => assertSafeWebUrl("https://169.254.169.254/latest")).toThrow(WebUrlError);
    expect(() => assertSafeWebUrl("https://metadata.google.internal/")).toThrow(WebUrlError);
    expect(() => assertSafeWebUrl("https://foo.internal/x")).toThrow(WebUrlError);
  });

  it("rejects DNS answers in private ranges", async () => {
    await expect(
      validateWebFetchUrl("https://example.com/a", async () => [{ address: "10.0.0.1", family: 4 }]),
    ).rejects.toMatchObject({ code: "WEB_FETCH_UNSAFE_URL" });
  });
});
