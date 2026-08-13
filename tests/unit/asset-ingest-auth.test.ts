import { describe, expect, it } from "vitest";
import { verifyIngestBearerToken } from "@/lib/asset-ingest/auth";

describe("asset-ingest auth", () => {
  it("accepts matching bearer token", () => {
    expect(
      verifyIngestBearerToken("Bearer secret-token-value", "secret-token-value"),
    ).toBe(true);
  });

  it("rejects missing/wrong tokens without throwing", () => {
    expect(verifyIngestBearerToken(null, "secret")).toBe(false);
    expect(verifyIngestBearerToken("Bearer wrong", "secret")).toBe(false);
    expect(verifyIngestBearerToken("Bearer secret", "")).toBe(false);
    expect(verifyIngestBearerToken("Basic secret", "secret")).toBe(false);
  });
});
