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
      `KIE Claude returned invalid JSON (HTTP ${response.status})`,
      retryableHttpStatus(response.status),
      response.status,
    );
  }
}

function extractText(payload: Record<string, unknown>): string {
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
    const endpoint = `${this.baseUrl.replace(/\/+$/, "")}/claude/v1/messages`;
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: input.model,
          max_tokens: input.maxTokens ?? 8192,
          stream: false,
          system: input.system,
          messages: [{ role: "user", content: input.prompt }],
          ...(input.thinking ? { thinkingFlag: true } : {}),
        }),
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      throw new KieClaudeTaskError(
        error instanceof Error ? error.message : "KIE Claude transport failure",
        true,
      );
    }

    const payload = await parsePayload(response);
    if (!response.ok) {
      throw new KieClaudeTaskError(
        `KIE Claude request failed (HTTP ${response.status})`,
        retryableHttpStatus(response.status),
        response.status,
      );
    }

    const text = extractText(payload);
    if (!text) {
      throw new KieClaudeTaskError("KIE Claude returned no text content", false, response.status);
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
