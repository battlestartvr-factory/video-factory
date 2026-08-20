import "server-only";

import { getKieConfig } from "@/lib/env/env.server";

export interface KieGeminiJsonResult {
  value: unknown;
  model: string;
  usage: Record<string, unknown>;
  rawText: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseProviderPayloads(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith("data:")) {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  const payloads: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      payloads.push(JSON.parse(data) as unknown);
    } catch {
      // A malformed stream chunk is ignored; the final JSON contract still fails closed below.
    }
  }
  return payloads;
}

function extractTextAndUsage(payloads: unknown[]): { text: string; usage: Record<string, unknown> } {
  const parts: string[] = [];
  let usage: Record<string, unknown> = {};
  for (const payload of payloads) {
    const root = object(payload);
    usage = { ...usage, ...object(root.usageMetadata ?? root.usage_metadata ?? root.usage) };
    for (const candidateValue of array(root.candidates)) {
      const candidate = object(candidateValue);
      const content = object(candidate.content);
      for (const partValue of array(content.parts)) {
        const text = object(partValue).text;
        if (typeof text === "string" && text.trim()) parts.push(text.trim());
      }
    }
  }
  return { text: parts.join("\n").trim(), usage };
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

export async function callKieGeminiJson(input: {
  prompt: string;
  model?: string;
  signal?: AbortSignal;
  temperature?: number;
}): Promise<KieGeminiJsonResult> {
  const kie = getKieConfig();
  if (!kie.configured) throw new Error("KIE_NOT_CONFIGURED");
  const model = input.model?.trim() || "gemini-3-6-flash";
  const endpoint = `${kie.baseUrl.replace(/\/+$/, "")}/gemini/v1/models/${encodeURIComponent(model)}:streamGenerateContent`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("KIE_JSON_TIMEOUT")), 90_000);
  const abort = () => controller.abort(input.signal?.reason ?? new Error("KIE_JSON_ABORTED"));
  input.signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${kie.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        stream: false,
        contents: [{ role: "user", parts: [{ text: input.prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: input.temperature ?? 0.35,
        },
      }),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`KIE_JSON_HTTP_${response.status}`);
    }
    const payloads = parseProviderPayloads(body);
    const extracted = extractTextAndUsage(payloads);
    if (!extracted.text) throw new Error("KIE_JSON_EMPTY_RESPONSE");
    let value: unknown;
    try {
      value = JSON.parse(stripJsonFence(extracted.text)) as unknown;
    } catch {
      throw new Error("KIE_JSON_INVALID_RESPONSE");
    }
    return {
      value,
      model,
      usage: extracted.usage,
      rawText: extracted.text.slice(0, 30_000),
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abort);
  }
}
