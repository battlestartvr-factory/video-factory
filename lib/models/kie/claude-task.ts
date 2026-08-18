import { getKieModelById, resolveModelId } from "./registry";

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

async function parsePayload(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return asObject(JSON.parse(text));
  } catch {
    throw new KieClaudeTaskError(
      `KIE LLM returned invalid JSON (HTTP ${response.status})`,
      retryableHttpStatus(response.status),
      response.status,
    );
  }
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
    if (!isOpenAiChat && model.adapter !== "claude_messages" && model.adapter !== "claude_sonnet") {
      throw new KieClaudeTaskError(
        `KIE LLM adapter ${model.adapter} is not supported by durable discovery`,
        false,
      );
    }

    const endpoint = joinUrl(this.baseUrl, model.endpoint);
    const body = isOpenAiChat
      ? {
          model: model.providerModel,
          max_tokens: input.maxTokens ?? 8192,
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
          ...(isOpenAiChat ? {} : { "anthropic-version": "2023-06-01" }),
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

    const payload = await parsePayload(response);
    if (!response.ok) {
      const detail = safeProviderErrorDetail(payload);
      throw new KieClaudeTaskError(
        `KIE LLM request failed for ${model.id} (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
        retryableHttpStatus(response.status),
        response.status,
      );
    }

    const text = isOpenAiChat ? extractOpenAiText(payload) : extractClaudeText(payload);
    if (!text) {
      throw new KieClaudeTaskError(
        `KIE LLM ${model.id} returned no text content`,
        false,
        response.status,
      );
    }

    if (isOpenAiChat) {
      const usage = asObject(payload.usage);
      const inputTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
      const outputTokens =
        typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
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
