import type { KieMarketTaskDetail, KieMarketSubmitResult, KieMarketTaskState } from "./market-task";
import { KieMarketTaskError } from "./market-task";

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return asObject(JSON.parse(text));
  } catch {
    throw new KieMarketTaskError(
      `KIE Veo returned invalid JSON (HTTP ${response.status})`,
      retryableHttpStatus(response.status),
    );
  }
}

export class KieVeoTaskAdapter {
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
      response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/api/v1/veo/generate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...input.providerInput,
          model: input.model,
          callBackUrl: input.callbackUrl,
        }),
        signal: input.signal,
      });
    } catch (error) {
      throw new KieMarketTaskError(
        error instanceof Error ? error.message : "KIE Veo generate transport failure",
        true,
        true,
      );
    }

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new KieMarketTaskError(
        `KIE Veo generate failed (HTTP ${response.status})`,
        retryableHttpStatus(response.status),
      );
    }

    const code = typeof payload.code === "number" ? payload.code : null;
    const data = asObject(payload.data);
    const taskId = typeof data.taskId === "string" ? data.taskId : null;
    if (code !== 200 || !taskId) {
      throw new KieMarketTaskError(
        `KIE Veo generate returned no accepted task id (code=${String(code)})`,
        false,
      );
    }

    return { taskId, payload };
  }

  async getTask(input: { taskId: string; signal?: AbortSignal }): Promise<KieMarketTaskDetail> {
    const url = new URL(`${this.baseUrl.replace(/\/+$/, "")}/api/v1/veo/record-info`);
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
        error instanceof Error ? error.message : "KIE Veo record-info transport failure",
        true,
      );
    }

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new KieMarketTaskError(
        `KIE Veo record-info failed (HTTP ${response.status})`,
        retryableHttpStatus(response.status),
      );
    }

    const data = asObject(payload.data);
    const taskId = typeof data.taskId === "string" ? data.taskId : null;
    const successFlag = typeof data.successFlag === "number" ? data.successFlag : null;
    if (!taskId || successFlag === null || ![0, 1, 2, 3].includes(successFlag)) {
      throw new KieMarketTaskError("KIE Veo record-info returned an invalid task payload", false);
    }

    const responseData = asObject(data.response);
    const resultUrls = Array.isArray(responseData.resultUrls)
      ? responseData.resultUrls.filter((item): item is string => typeof item === "string" && Boolean(item))
      : [];
    const state: KieMarketTaskState =
      successFlag === 0 ? "generating" : successFlag === 1 ? "success" : "fail";

    return {
      taskId,
      model: null,
      state,
      resultUrls,
      failCode:
        typeof data.errorCode === "string" && data.errorCode
          ? data.errorCode
          : successFlag >= 2
            ? "VEO_GENERATION_FAILED"
            : null,
      failMessage:
        typeof data.errorMessage === "string" && data.errorMessage
          ? data.errorMessage
          : successFlag >= 2
            ? "KIE Veo generation failed"
            : null,
      progress: state === "success" ? 100 : null,
      creditsConsumed: null,
      payload,
    };
  }
}
