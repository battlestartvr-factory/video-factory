export type KieMarketTaskState = "waiting" | "queuing" | "generating" | "success" | "fail";

export interface KieMarketSubmitResult {
  taskId: string;
  payload: Record<string, unknown>;
}

export interface KieMarketTaskDetail {
  taskId: string;
  model: string | null;
  state: KieMarketTaskState;
  resultUrls: string[];
  failCode: string | null;
  failMessage: string | null;
  progress: number | null;
  creditsConsumed: number | null;
  payload: Record<string, unknown>;
}

export class KieMarketTaskError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly ambiguousSubmit = false,
    readonly providerCode: number | string | null = null,
    readonly providerMessage: string | null = null,
  ) {
    super(message);
    this.name = "KieMarketTaskError";
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseResultUrls(value: unknown): string[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  const obj = asObject(parsed);
  return Array.isArray(obj.resultUrls)
    ? obj.resultUrls.filter((item): item is string => typeof item === "string")
    : [];
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function safeProviderMessage(payload: Record<string, unknown>): string | null {
  const value = payload.msg ?? payload.message;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 1_000) : null;
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return asObject(JSON.parse(text));
  } catch {
    throw new KieMarketTaskError(
      `KIE returned invalid JSON (HTTP ${response.status})`,
      retryableHttpStatus(response.status),
    );
  }
}

export class KieMarketTaskAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async submit(input: {
    model: string;
    callbackUrl: string;
    providerInput: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<KieMarketSubmitResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/api/v1/jobs/createTask`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          callBackUrl: input.callbackUrl,
          input: input.providerInput,
        }),
        signal: input.signal,
      });
    } catch (error) {
      // A transport failure after bytes may have reached KIE is ambiguous. The caller must
      // NOT automatically POST again; wait for callback/reconciliation instead.
      throw new KieMarketTaskError(
        error instanceof Error ? error.message : "KIE createTask transport failure",
        true,
        true,
      );
    }

    const payload = await parseJsonResponse(response);
    const providerMessage = safeProviderMessage(payload);
    const rawCode = payload.code;
    const providerCode =
      typeof rawCode === "number" || typeof rawCode === "string" ? rawCode : null;

    if (!response.ok) {
      throw new KieMarketTaskError(
        `KIE createTask failed (HTTP ${response.status})${providerMessage ? `: ${providerMessage}` : ""}`,
        retryableHttpStatus(response.status),
        false,
        providerCode,
        providerMessage,
      );
    }

    const code = typeof payload.code === "number" ? payload.code : null;
    const data = asObject(payload.data);
    const taskId = typeof data.taskId === "string" ? data.taskId : null;
    if (code !== 200 || !taskId) {
      throw new KieMarketTaskError(
        `KIE createTask rejected (code=${String(code)})${providerMessage ? `: ${providerMessage}` : ""}`,
        false,
        false,
        providerCode,
        providerMessage,
      );
    }

    return { taskId, payload };
  }

  async getTask(input: { taskId: string; signal?: AbortSignal }): Promise<KieMarketTaskDetail> {
    const url = new URL(`${this.baseUrl.replace(/\/+$/, "")}/api/v1/jobs/recordInfo`);
    url.searchParams.set("taskId", input.taskId);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: input.signal,
      });
    } catch (error) {
      throw new KieMarketTaskError(
        error instanceof Error ? error.message : "KIE recordInfo transport failure",
        true,
      );
    }

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new KieMarketTaskError(
        `KIE recordInfo failed (HTTP ${response.status})`,
        retryableHttpStatus(response.status),
      );
    }

    const data = asObject(payload.data);
    const taskId = typeof data.taskId === "string" ? data.taskId : null;
    const state = typeof data.state === "string" ? data.state : null;
    if (
      !taskId ||
      !state ||
      !["waiting", "queuing", "generating", "success", "fail"].includes(state)
    ) {
      throw new KieMarketTaskError("KIE recordInfo returned an invalid task payload", false);
    }

    return {
      taskId,
      model: typeof data.model === "string" ? data.model : null,
      state: state as KieMarketTaskState,
      resultUrls: parseResultUrls(data.resultJson),
      failCode: typeof data.failCode === "string" && data.failCode ? data.failCode : null,
      failMessage: typeof data.failMsg === "string" && data.failMsg ? data.failMsg : null,
      progress: typeof data.progress === "number" ? data.progress : null,
      creditsConsumed: typeof data.creditsConsumed === "number" ? data.creditsConsumed : null,
      payload,
    };
  }
}
