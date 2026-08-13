import { afterEach, describe, expect, it, vi } from "vitest";
import { isMockWorkflowsEnabled } from "@/lib/env/mock-workflows";

describe("isMockWorkflowsEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns true when MOCK_WORKFLOWS="true"', () => {
    vi.stubEnv("MOCK_WORKFLOWS", "true");
    expect(isMockWorkflowsEnabled()).toBe(true);
  });

  it('returns false when MOCK_WORKFLOWS="false"', () => {
    vi.stubEnv("MOCK_WORKFLOWS", "false");
    expect(isMockWorkflowsEnabled()).toBe(false);
  });

  it("returns false when MOCK_WORKFLOWS is absent", () => {
    vi.stubEnv("MOCK_WORKFLOWS", undefined);
    expect(isMockWorkflowsEnabled()).toBe(false);
  });

  it("returns false for empty MOCK_WORKFLOWS", () => {
    vi.stubEnv("MOCK_WORKFLOWS", "");
    expect(isMockWorkflowsEnabled()).toBe(false);
  });

  it('does not treat Boolean("false") as true', () => {
    vi.stubEnv("MOCK_WORKFLOWS", "false");
    expect(Boolean(process.env.MOCK_WORKFLOWS)).toBe(true);
    expect(isMockWorkflowsEnabled()).toBe(false);
  });
});
