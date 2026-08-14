import { describe, expect, it } from "vitest";
import { redactForStorage, redactValue, stripSignedUrl } from "@/lib/agent/redaction";
import { requiresExplicitCommand } from "@/lib/agent/confirmation";
import { chunkText } from "@/lib/knowledge/extraction";
import { parseStructuredFallback, parseToolCalls } from "@/lib/agent/provider";
import { toolEventLabel } from "@/lib/agent/events";

describe("redaction", () => {
  it("redacts secrets and signed URLs", () => {
    const redacted = redactForStorage({
      api_key: "sk-secret",
      Authorization: "Bearer abc",
      url: "https://bucket.example/file?X-Amz-Signature=deadbeef&foo=1",
    });
    expect(redacted.api_key).toBe("[redacted]");
    expect(redacted.Authorization).toBe("[redacted]");
    expect(String(redacted.url)).not.toContain("deadbeef");
    expect(stripSignedUrl("https://cdn.example/a.png?token=abc")).toBe("https://cdn.example/a.png");
  });

  it("truncates large strings", () => {
    const value = redactValue("a".repeat(5000));
    expect(String(value).includes("[truncated]")).toBe(true);
  });
});

describe("confirmation policy", () => {
  it("requires an explicit project create command", () => {
    expect(requiresExplicitCommand("сделай картинку", "create_project")).toBe(false);
    expect(requiresExplicitCommand("Создай проект Battle Start", "create_project")).toBe(true);
  });

  it("requires an explicit instruction overwrite", () => {
    expect(requiresExplicitCommand("как дела", "update_instructions")).toBe(false);
    expect(requiresExplicitCommand("обнови инструкции проекта", "update_instructions")).toBe(true);
  });
});

describe("knowledge extraction", () => {
  it("reuses paragraph chunking", () => {
    const text = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} ${"word ".repeat(80)}`).join(
      "\n\n",
    );
    const chunks = chunkText(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(" ")).toContain("Paragraph 0");
  });
});

describe("provider adapters", () => {
  it("parses OpenAI tool_calls", () => {
    const calls = parseToolCalls([
      {
        id: "call-1",
        function: { name: "web_search", arguments: '{"query":"VR"}' },
      },
    ]);
    expect(calls[0]).toMatchObject({ id: "call-1", name: "web_search", arguments: { query: "VR" } });
  });

  it("parses structured output fallback", () => {
    const parsed = parseStructuredFallback(
      'Here\n{"content":null,"tool_calls":[{"name":"generate_image","arguments":{"prompt":"cat"}}]}',
    );
    expect(parsed.toolCalls[0]?.name).toBe("generate_image");
  });
});

describe("tool events", () => {
  it("maps tools to user-facing progress labels", () => {
    expect(toolEventLabel("web_search")).toContain("актуальн");
    expect(toolEventLabel("generate_video")).toContain("видео");
  });
});
