import { describe, it, expect } from "vitest";
import { canTransition, assertTransition } from "@/lib/jobs/status-transitions";

describe("status transitions", () => {
  it("allows draft → queued", () => {
    expect(canTransition("draft", "queued")).toBe(true);
  });

  it("allows queued → processing", () => {
    expect(canTransition("queued", "processing")).toBe(true);
  });

  it("allows processing → review", () => {
    expect(canTransition("processing", "review")).toBe(true);
  });

  it("allows review → completed", () => {
    expect(canTransition("review", "completed")).toBe(true);
  });

  it("allows failed → queued via retry", () => {
    expect(canTransition("failed", "queued")).toBe(true);
  });

  it("rejects completed → processing", () => {
    expect(canTransition("completed", "processing")).toBe(false);
  });

  it("throws on invalid transition", () => {
    expect(() => assertTransition("completed", "queued")).toThrow();
  });
});
