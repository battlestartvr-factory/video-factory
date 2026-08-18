export interface DurableErrorShape {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
}

export class DurableWorkflowError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(input: {
    code: string;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "DurableWorkflowError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
    this.details = input.details;
  }
}

const DEFAULT_BACKOFF_MS = [5_000, 20_000, 60_000, 180_000, 600_000] as const;

/**
 * Persistence failures are often marked retryable because an RPC transport can fail
 * after the database commit and the next tick can reconcile persisted state. A
 * deterministic PostgreSQL contract error is different: retrying cannot heal it and,
 * for Stage 4, may cause the paid LLM stage immediately before persistence to run
 * again. Fail closed instead of silently spending through the retry budget.
 */
function isDeterministicPersistenceContractError(error: DurableWorkflowError): boolean {
  if (!error.code.endsWith("_PERSIST_FAILED")) return false;
  const message = error.message.toLowerCase();
  return message.includes("no unique or exclusion constraint matching the on conflict specification");
}

export function normalizeWorkflowError(error: unknown): DurableErrorShape {
  if (error instanceof DurableWorkflowError) {
    const retrySuppressed = isDeterministicPersistenceContractError(error);
    return {
      code: error.code,
      message: error.message,
      retryable: retrySuppressed ? false : error.retryable,
      retryAfterMs: retrySuppressed ? undefined : error.retryAfterMs,
      details: retrySuppressed
        ? { ...(error.details ?? {}), retry_suppressed: "deterministic_persistence_contract" }
        : error.details,
    };
  }

  if (error instanceof Error) {
    return {
      code: "WORKFLOW_TICK_FAILED",
      message: error.message,
      retryable: false,
      details: { name: error.name },
    };
  }

  return {
    code: "WORKFLOW_TICK_FAILED",
    message: String(error),
    retryable: false,
  };
}

export function computeRetryDelayMs(input: {
  retryCount: number;
  retryAfterMs?: number;
  random?: () => number;
}): number {
  if (input.retryAfterMs !== undefined) {
    return Math.max(0, Math.ceil(input.retryAfterMs));
  }

  const index = Math.min(Math.max(input.retryCount, 0), DEFAULT_BACKOFF_MS.length - 1);
  const base = DEFAULT_BACKOFF_MS[index];
  const random = input.random ?? Math.random;
  const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return Math.max(1_000, Math.round(base * jitter));
}

export function shouldRetry(input: {
  retryable: boolean;
  retryCount: number;
  maxAttempts: number;
}): boolean {
  const currentAttempt = Math.max(0, input.retryCount) + 1;
  return input.retryable && currentAttempt < input.maxAttempts;
}
