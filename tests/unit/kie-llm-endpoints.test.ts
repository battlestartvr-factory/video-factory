import { describe, expect, it } from "vitest";
import { joinKieUrl } from "@/lib/models/kie/adapters/base";
import {
  classifyKieHttpStatus,
  normalizeKieError,
  parseKieErrorBody,
} from "@/lib/models/kie/errors";
import { PROVIDER_ERROR_CODES } from "@/lib/models/kie/types";
import { getKieModelById } from "@/lib/models/kie/registry";
import { resolveReasoning } from "@/lib/models/kie/reasoning";
import { normalizeKieBaseUrl } from "@/lib/env/env.server";

const KIE_ROOT = "https://api.kie.ai";

describe("KIE LLM endpoint URLs", () => {
  const cases = [
    {
      modelId: "gemini-3-6-flash",
      expected: `${KIE_ROOT}/gemini-3-6-flash-openai/v1/chat/completions`,
    },
    {
      modelId: "gemini-3-pro",
      expected: `${KIE_ROOT}/gemini-3-pro/v1/chat/completions`,
    },
    {
      modelId: "gpt-5-6-sol",
      expected: `${KIE_ROOT}/codex/v1/responses`,
    },
    {
      modelId: "claude-sonnet-5",
      expected: `${KIE_ROOT}/claude/v1/messages`,
    },
    {
      modelId: "claude-opus-5",
      expected: `${KIE_ROOT}/claude/v1/messages`,
    },
  ] as const;

  it.each(cases)("resolves $modelId to the canonical KIE URL", ({ modelId, expected }) => {
    const model = getKieModelById(modelId);
    expect(model).toBeDefined();
    expect(joinKieUrl(KIE_ROOT, model!.endpoint)).toBe(expected);
  });
});

describe("KIE base URL normalization", () => {
  it("strips model-specific legacy AGENT_LLM_BASE_URL paths to provider root", () => {
    expect(
      normalizeKieBaseUrl("https://api.kie.ai/gemini-3-6-flash-openai/v1/chat/completions"),
    ).toBe("https://api.kie.ai");
    expect(normalizeKieBaseUrl("https://api.kie.ai/codex/v1/responses")).toBe("https://api.kie.ai");
    expect(normalizeKieBaseUrl("https://api.kie.ai/")).toBe("https://api.kie.ai");
  });

  it("preserves non-KIE legacy base URLs unchanged", () => {
    expect(normalizeKieBaseUrl("https://proxy.example.com/v1")).toBe("https://proxy.example.com/v1");
  });
});

describe("KIE LLM request contracts", () => {
  it("maps GPT 5.6 Sol reasoning to reasoning.effort", () => {
    const model = getKieModelById("gpt-5-6-sol")!;
    const resolved = resolveReasoning(model, "max");
    expect(resolved.providerParam).toEqual({ reasoning: { effort: "xhigh" } });
  });

  it("maps Claude Sonnet thinking to thinkingFlag", () => {
    const model = getKieModelById("claude-sonnet-5")!;
    expect(resolveReasoning(model, "on").providerParam).toEqual({ thinkingFlag: true });
    expect(resolveReasoning(model, "off").providerParam).toEqual({ thinkingFlag: false });
  });

  it("maps Claude Opus thinking to thinkingFlag", () => {
    const model = getKieModelById("claude-opus-5")!;
    expect(resolveReasoning(model, "on").providerParam).toEqual({ thinkingFlag: true });
    expect(resolveReasoning(model, "off").providerParam).toEqual({ thinkingFlag: false });
  });

  it("maps Gemini reasoning to reasoning_effort", () => {
    const model = getKieModelById("gemini-3-6-flash")!;
    const resolved = resolveReasoning(model, "high");
    expect(resolved.providerParam).toEqual({ reasoning_effort: "high" });
  });
});

describe("KIE provider error diagnostics", () => {
  it("classifies HTTP status codes for server logs", () => {
    expect(classifyKieHttpStatus(401)).toBe("authentication");
    expect(classifyKieHttpStatus(404)).toBe("wrong_endpoint");
    expect(classifyKieHttpStatus(400)).toBe("invalid_request");
    expect(classifyKieHttpStatus(429)).toBe("rate_limit");
    expect(classifyKieHttpStatus(500)).toBe("provider_failure");
  });

  it("parses provider error metadata without exposing secrets", () => {
    const parsed = parseKieErrorBody(
      JSON.stringify({
        error: { type: "authentication_error", message: "Invalid API key" },
        id: "req_abc123",
      }),
    );
    expect(parsed).toEqual({
      providerErrorType: "authentication_error",
      requestId: "req_abc123",
    });
  });

  it("keeps user-facing errors normalized", () => {
    expect(normalizeKieError(401, '{"error":{"type":"authentication_error"}}').code).toBe(
      PROVIDER_ERROR_CODES.PROVIDER_ERROR,
    );
    expect(normalizeKieError(404, "").code).toBe(PROVIDER_ERROR_CODES.MODEL_UNAVAILABLE);
    expect(normalizeKieError(400, '{"error":{"type":"invalid_request_error"}}').code).toBe(
      PROVIDER_ERROR_CODES.PROVIDER_ERROR,
    );
  });
});
