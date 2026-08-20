import { DurableWorkflowError } from "../orchestrator/retry";
import type {
  ResearchScoutExecutionResult,
  ResearchScoutExecutor,
  ResearchScoutJobContext,
} from "./scout-runtime";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const NON_RETRYABLE_RESEARCH_CODES = new Set([
  "WEB_SEARCH_GROUNDING_MISSING",
  "WEB_SEARCH_INVALID_RESPONSE",
  "WEB_SEARCH_NOT_CONFIGURED",
  "RESEARCH_SCOUT_NO_GROUNDED_SOURCES",
  "RESEARCH_SCOUT_NO_SAFE_FETCHED_SOURCES",
  "RESEARCH_SCOUT_GROUNDED_CLAIMS_MISSING",
  "RESEARCH_SCOUT_ALREADY_PERSISTED",
  "RESEARCH_SCOUT_ROLE_MISMATCH",
  "INVALID_REQUEST",
]);

function isRetryableResearchFailure(code: string, status: number): boolean {
  if (NON_RETRYABLE_RESEARCH_CODES.has(code)) return false;
  return status === 429 || status >= 500;
}

export class InternalKieResearchScoutExecutor implements ResearchScoutExecutor {
  constructor(
    private readonly appUrl: string,
    private readonly serviceRoleKey: string,
  ) {}

  async execute(input: {
    jobId: string;
    context: ResearchScoutJobContext;
    signal: AbortSignal;
  }): Promise<ResearchScoutExecutionResult> {
    const response = await fetch(
      `${this.appUrl.replace(/\/+$/, "")}/api/internal/research-scout-execute`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jobId: input.jobId, context: input.context }),
        signal: input.signal,
      },
    );
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = object(text.trim() ? JSON.parse(text) : {});
    } catch {
      throw new DurableWorkflowError({
        code: "KIE_RESEARCH_INTERNAL_INVALID_RESPONSE",
        message: "Internal KIE research endpoint returned invalid JSON",
        retryable: response.status >= 500,
      });
    }

    if (!response.ok || payload.ok !== true) {
      const code = typeof payload.code === "string" ? payload.code : "KIE_RESEARCH_INTERNAL_FAILED";
      const message = typeof payload.message === "string"
        ? payload.message
        : `Internal KIE research endpoint returned ${response.status}`;
      throw new DurableWorkflowError({
        code,
        message,
        retryable: isRetryableResearchFailure(code, response.status),
        details: { http_status: response.status },
      });
    }

    const data = object(payload.data);
    if (!data.report || typeof data.report !== "object") {
      throw new DurableWorkflowError({
        code: "KIE_RESEARCH_INTERNAL_INVALID_RESULT",
        message: "Internal KIE research endpoint returned no Scout report",
        retryable: false,
      });
    }
    return data as unknown as ResearchScoutExecutionResult;
  }
}

export function createInternalKieResearchScoutExecutor(): ResearchScoutExecutor | null {
  if ((process.env.WEB_SEARCH_PROVIDER ?? "").trim().toLowerCase() !== "kie") return null;
  if (!(process.env.KIE_API_KEY ?? process.env.AGENT_LLM_API_KEY ?? "").trim()) return null;
  const serviceRoleKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? ""
  ).trim();
  if (!serviceRoleKey) return null;
  const appUrl = (process.env.WORKER_APP_INTERNAL_URL ?? "http://app:3000").trim() || "http://app:3000";
  return new InternalKieResearchScoutExecutor(appUrl, serviceRoleKey);
}
