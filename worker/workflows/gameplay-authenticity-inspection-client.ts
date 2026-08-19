import {
  gameplayImageAuthenticityInspectionV1Schema,
  gameplayVideoAuthenticityInspectionV1Schema,
  type GameplayImageAuthenticityInspectionV1,
  type GameplayVideoAuthenticityInspectionV1,
} from "../../lib/game-discovery/gameplay-authenticity-inspection";
import type { GameplayAuthenticitySpecV1 } from "../../lib/game-discovery/gameplay-authenticity";

function internalBaseUrl(): string {
  return (process.env.WORKER_APP_INTERNAL_URL ?? "http://app:3000").trim() || "http://app:3000";
}

function serviceToken(): string {
  const token = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? "").trim();
  if (!token) throw new Error("GAMEPLAY_AUTHENTICITY_INSPECTION_SERVICE_TOKEN_MISSING");
  return token;
}

async function requestInspection<T>(body: Record<string, unknown>, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${internalBaseUrl()}/api/internal/gameplay-authenticity-inspect`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  const raw = await response.text();
  let payload: { ok?: boolean; code?: string; message?: string; data?: T } = {};
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    // Never surface an upstream HTML body.
  }
  if (!response.ok || payload.ok !== true || !payload.data) {
    throw new Error(
      `${payload.code ?? "GAMEPLAY_AUTHENTICITY_INSPECTION_UPSTREAM_FAILED"}:${payload.message ?? response.status}`,
    );
  }
  return payload.data;
}

export function outputDriveFileId(outputs: Array<Record<string, unknown>>): string | null {
  for (const output of outputs) {
    const candidate = output.driveFileId ?? output.drive_file_id;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

export async function inspectGameplayImageFromWorker(input: {
  rootCreativeRunId: string;
  generationId: string;
  shotId: string;
  conceptId: string;
  momentId: string;
  driveFileId: string;
  plannedAuthenticity: GameplayAuthenticitySpecV1;
  signal: AbortSignal;
}): Promise<GameplayImageAuthenticityInspectionV1> {
  const data = await requestInspection<{ inspection: unknown }>(
    { action: "image", ...input, signal: undefined },
    input.signal,
  );
  return gameplayImageAuthenticityInspectionV1Schema.parse(data.inspection);
}

export async function inspectGameplayVideoFromWorker(input: {
  rootCreativeRunId: string;
  generationId: string;
  shotId: string;
  conceptId: string;
  momentId: string;
  driveFileId: string;
  plannedAuthenticity: GameplayAuthenticitySpecV1;
  signal: AbortSignal;
}): Promise<GameplayVideoAuthenticityInspectionV1> {
  const data = await requestInspection<{ inspection: unknown }>(
    { action: "video", ...input, signal: undefined },
    input.signal,
  );
  return gameplayVideoAuthenticityInspectionV1Schema.parse(data.inspection);
}
