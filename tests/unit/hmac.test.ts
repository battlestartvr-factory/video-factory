import { describe, it, expect } from "vitest";
import { signPayload, verifyHmacSignature, verifyTimestamp } from "@/lib/n8n/hmac";

describe("HMAC verification", () => {
  const secret = "test-secret-key";
  const body = JSON.stringify({ event: "job.updated", jobId: "123" });

  it("signs and verifies payload", () => {
    const sig = signPayload(body, secret);
    expect(verifyHmacSignature(body, sig, secret)).toBe(true);
  });

  it("rejects invalid signature", () => {
    expect(verifyHmacSignature(body, "deadbeef", secret)).toBe(false);
  });

  it("rejects null signature", () => {
    expect(verifyHmacSignature(body, null, secret)).toBe(false);
  });
});

describe("timestamp verification", () => {
  it("accepts current timestamp", () => {
    const now = Math.floor(Date.now() / 1000).toString();
    expect(verifyTimestamp(now)).toBe(true);
  });

  it("rejects old timestamp", () => {
    const old = (Math.floor(Date.now() / 1000) - 600).toString();
    expect(verifyTimestamp(old)).toBe(false);
  });
});
