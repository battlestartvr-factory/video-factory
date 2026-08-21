import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { OrchestratorQueueMode } from "../lib/orchestrator/queue/pgmq";

export interface WorkerConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  workerId: string;
  buildSha: string | null;
  appUrl: string;
  kieApiKey: string | null;
  kieApiBaseUrl: string;
  queueMode: OrchestratorQueueMode;
  workerConcurrency: number;
  mockWorkflows: boolean;
  queuePollMs: number;
  leaseSeconds: number;
  visibilitySeconds: number;
  leaseHeartbeatMs: number;
  workerHeartbeatMs: number;
  watchdogMs: number;
  maxAttempts: number;
}

function requiredEnv(name: string, fallbackName?: string): string {
  const raw = process.env[name] ?? (fallbackName ? process.env[fallbackName] : undefined);
  const value = raw?.trim().replace(/^['"]|['"]$/g, "");
  if (!value) throw new Error(`${name} is required for the durable worker`);
  return value;
}

function optionalEnv(name: string): string | null {
  const value = process.env[name]?.trim().replace(/^['"]|['"]$/g, "");
  return value || null;
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function booleanEnv(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be a boolean`);
}

function queueModeEnv(): OrchestratorQueueMode {
  const value = (process.env.ORCHESTRATOR_QUEUE_MODE ?? "core").trim().toLowerCase();
  if (value === "core" || value === "research") return value;
  throw new Error("ORCHESTRATOR_QUEUE_MODE must be core or research");
}

export function loadWorkerConfig(): WorkerConfig {
  const workerId =
    process.env.ORCHESTRATOR_WORKER_ID?.trim() ||
    `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  const leaseSeconds = integerEnv("ORCHESTRATOR_LEASE_SECONDS", 90, 15, 900);
  const visibilitySeconds = integerEnv("ORCHESTRATOR_VISIBILITY_SECONDS", 120, 15, 3600);
  // Heartbeat is also the durable cancellation fence: orchestrator_request_cancel clears
  // the active lease, so the next heartbeat aborts the in-flight job. Keep this short
  // enough for a ChatGPT-style Stop button without introducing a second polling loop.
  const leaseHeartbeatMs = integerEnv("ORCHESTRATOR_LEASE_HEARTBEAT_MS", 1_000, 250, 300_000);
  const queueMode = queueModeEnv();

  if (leaseHeartbeatMs >= leaseSeconds * 1000) {
    throw new Error("ORCHESTRATOR_LEASE_HEARTBEAT_MS must be shorter than the DB lease");
  }

  return {
    supabaseUrl: requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    serviceRoleKey: requiredEnv("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"),
    workerId,
    buildSha: process.env.BUILD_SHA?.trim() || process.env.GIT_COMMIT?.trim() || null,
    appUrl: optionalEnv("APP_URL") ?? "http://localhost:3000",
    kieApiKey: optionalEnv("KIE_API_KEY"),
    kieApiBaseUrl: optionalEnv("KIE_API_BASE_URL") ?? "https://api.kie.ai",
    queueMode,
    workerConcurrency: integerEnv("WORKER_CONCURRENCY", queueMode === "research" ? 5 : 1, 1, 10),
    mockWorkflows: booleanEnv("MOCK_WORKFLOWS", false),
    queuePollMs: integerEnv("ORCHESTRATOR_QUEUE_POLL_MS", 1000, 100, 60_000),
    leaseSeconds,
    visibilitySeconds,
    leaseHeartbeatMs,
    workerHeartbeatMs: integerEnv("ORCHESTRATOR_WORKER_HEARTBEAT_MS", 15_000, 5_000, 300_000),
    watchdogMs: integerEnv("ORCHESTRATOR_WATCHDOG_MS", 60_000, 15_000, 3_600_000),
    maxAttempts: integerEnv("ORCHESTRATOR_MAX_ATTEMPTS", 5, 1, 20),
  };
}
