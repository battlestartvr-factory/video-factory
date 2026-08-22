import { getKieModelById, resolveModelId } from "./registry";
import { resolveReasoning } from "./reasoning";

export interface KieClaudeUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface KieClaudeGenerateResult {
  text: string;
  usage: KieClaudeUsage;
  stopReason: string | null;
  responsePayload: Record<string, unknown>;
}

/**
 * Historical name kept for worker/API compatibility. The adapter is now provider-neutral
 * for durable discovery LLM work and dispatches by the KIE model registry.
 */
export class KieClaudeTaskError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "KieClaudeTaskError";
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    const object = asObject(parsed);
    return Object.keys(object).length ? object : null;
  } catch {
    return null;
  }
}

function parseSsePayloads(text: string): Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = [];
  let dataLines: string[] = [];

  const flush = () => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") return;
    const parsed = parseJsonObject(data);
    if (parsed) payloads.push(parsed);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  flush();
  return payloads;
}

function responseCandidate(payload: Record<string, unknown>): Record<string, unknown> | null {
  const nested = asObject(payload.response);
  if (Object.keys(nested).length) return nested;
  if (
    Array.isArray(payload.output) ||
    typeof payload.output_text === "string" ||
    typeof payload.status === "string" ||
    Object.keys(asObject(payload.usage)).length
  ) {
    return payload;
  }
  return null;
}

function synthesizeResponsesPayload(payloads: Record<string, unknown>[]): Record<string, unknown> | null {
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const candidate = responseCandidate(payloads[index] ?? {});
    if (candidate && (Array.isArray(candidate.output) || typeof candidate.output_text === "string")) {
      return candidate;
    }
  }

  const deltas: string[] = [];
  let usage: Record<string, unknown> = {};
  let status: string | null = null;
  let creditsConsumed: number | null = null;
  for (const payload of payloads) {
    const nested = asObject(payload.response);
    const source = Object.keys(nested).length ? nested : payload;
    const delta = source.delta ?? payload.delta;
    if (typeof delta === "string") deltas.push(delta);
    const outputText = source.output_text ?? payload.output_text;
    if (typeof outputText === "string") deltas.push(outputText);
    const sourceUsage = asObject(source.usage);
    if (Object.keys(sourceUsage).length) usage = sourceUsage;
    if (typeof source.status === "string") status = source.status;
    const credits = source.credits_consumed ?? payload.credits_consumed;
    if (typeof credits === "number") creditsConsumed = credits;
  }
  const text = deltas.join("");
  if (!text.trim()) return null;
  return {
    output_text: text,
    ...(Object.keys(usage).length ? { usage } : {}),
    ...(status ? { status } : {}),
    ...(creditsConsumed !== null ? { credits_consumed: creditsConsumed } : {}),
  };
}

async function parsePayload(response: Response, responsesApi = false): Promise<Record<string, unknown>> {
  const text = await response.text();
  const direct = parseJsonObject(text.trim());
  if (direct) return direct;

  if (responsesApi) {
    const payloads = parseSsePayloads(text);
    const synthesized = synthesizeResponsesPayload(payloads);
    if (synthesized) return synthesized;
  }

  throw new KieClaudeTaskError(
    `KIE LLM returned invalid JSON response (HTTP ${response.status})`,
    retryableHttpStatus(response.status),
    response.status,
  );
}

function extractClaudeText(payload: Record<string, unknown>): string {
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("")
    .trim();
}

function extractOpenAiText(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = asObject(choices[0]);
  const message = asObject(first.message);
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => asObject(part))
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function extractResponsesText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const output = Array.isArray(payload.output) ? payload.output : [];
  const chunks: string[] = [];
  for (const rawItem of output) {
    const item = asObject(rawItem);
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const rawPart of item.content) {
        const part = asObject(rawPart);
        if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
          chunks.push(part.text);
        }
      }
    } else if ((item.type === "output_text" || item.type === "text") && typeof item.text === "string") {
      chunks.push(item.text);
    }
  }
  return chunks.join("").trim();
}

function safeProviderErrorDetail(payload: Record<string, unknown>): string | null {
  const error = asObject(payload.error);
  const candidates = [error.message, payload.message, payload.detail, error.type];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const cleaned = candidate.replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const redacted = cleaned
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/(api[_ -]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
    return redacted.slice(0, 500);
  }
  return null;
}

function joinUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
}

/**
 * Older workflow code passed Claude ids directly. Keep those durable jobs restartable
 * after the routing policy change by translating the old role names at the adapter edge.
 */
function resolveDurableModelId(requested: string): string {
  const resolved = resolveModelId(requested);
  if (resolved === "claude-sonnet-5") return "gemini-3-pro";
  if (resolved === "claude-haiku-4-5") return "gemini-3-6-flash";
  return resolved;
}

export class KieClaudeTaskAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async generate(input: {
    model: string;
    system: string;
    prompt: string;
    maxTokens?: number;
    thinking?: boolean;
    signal?: AbortSignal;
  }): Promise<KieClaudeGenerateResult> {
    const effectiveModelId = resolveDurableModelId(input.model);
    const model = getKieModelById(effectiveModelId);
    if (!model || model.category !== "llm") {
      throw new KieClaudeTaskError(`KIE LLM model is unavailable: ${effectiveModelId}`, false);
    }

    const isOpenAiChat = model.adapter === "openai_chat";
    const isResponses = model.adapter === "responses";
    if (
      !isOpenAiChat &&
      !isResponses &&
      model.adapter !== "claude_messages" &&
      model.adapter !== "claude_sonnet"
    ) {
      throw new KieClaudeTaskError(
        `KIE LLM adapter ${model.adapter} is not supported by durable discovery`,
        false,
      );
    }

    const endpoint = joinUrl(this.baseUrl, model.endpoint);
    const body = isResponses
      ? {
          model: model.providerModel,
          stream: false,
          input: [
            { role: "system", content: [{ type: "input_text", text: input.system }] },
            { role: "user", content: [{ type: "input_text", text: input.prompt }] },
          ],
          max_output_tokens: input.maxTokens ?? 8192,
          ...resolveReasoning(model, input.thinking ? "high" : "medium").providerParam,
        }
      : isOpenAiChat
        ? {
            model: model.providerModel,
            stream: false,
            messages: [
              { role: "system", content: input.system },
              { role: "user", content: input.prompt },
            ],
            temperature: 0.4,
          }
        : {
            model: model.providerModel,
            max_tokens: input.maxTokens ?? 8192,
            stream: false,
            system: input.system,
            messages: [{ role: "user", content: input.prompt }],
            ...(input.thinking ? { thinkingFlag: true } : {}),
          };

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(!isOpenAiChat && !isResponses ? { "anthropic-version": "2023-06-01" } : {}),
        },
        body: JSON.stringify(body),
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      throw new KieClaudeTaskError(
        error instanceof Error ? error.message : "KIE LLM transport failure",
        true,
      );
    }

    const payload = await parsePayload(response, isResponses);
    if (!response.ok) {
      const detail = safeProviderErrorDetail(payload);
      throw new KieClaudeTaskError(
        `KIE LLM request failed for ${model.id} (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
        retryableHttpStatus(response.status),
        response.status,
      );
    }

    const text = isResponses
      ? extractResponsesText(payload)
      : isOpenAiChat
        ? extractOpenAiText(payload)
        : extractClaudeText(payload);
    if (!text) {
      throw new KieClaudeTaskError(
        `KIE LLM ${model.id} returned no text content`,
        false,
        response.status,
      );
    }

    if (isResponses) {
      const usage = asObject(payload.usage);
      const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : null;
      const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : null;
      const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : null;
      return {
        text,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens:
            totalTokens ??
            (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
        },
        stopReason: typeof payload.status === "string" ? payload.status : null,
        responsePayload: payload,
      };
    }

    if (isOpenAiChat) {
      const usage = asObject(payload.usage);
      const inputTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
      const outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
      const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : null;
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const first = asObject(choices[0]);
      return {
        text,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens:
            totalTokens ??
            (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
        },
        stopReason: typeof first.finish_reason === "string" ? first.finish_reason : null,
        responsePayload: payload,
      };
    }

    const usage = asObject(payload.usage);
    const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : null;
    const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : null;
    return {
      text,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens:
          inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
      },
      stopReason: typeof payload.stop_reason === "string" ? payload.stop_reason : null,
      responsePayload: payload,
    };
  }
}
