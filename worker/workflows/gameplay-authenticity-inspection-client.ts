import {
  gameplayImageAuthenticityInspectionV1Schema,
  gameplayVideoAuthenticityInspectionV1Schema,
  type GameplayImageAuthenticityInspectionV1,
  type GameplayVideoAuthenticityInspectionV1,
} from "../../lib/game-discovery/gameplay-authenticity-inspection";
import type { GameplayAuthenticitySpecV1 } from "../../lib/game-discovery/gameplay-authenticity";

const VIDEO_INSPECTION_ATTEMPTS = 2;

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

export function outputProviderUrl(outputs: Array<Record<string, unknown>>): string | null {
  for (const output of outputs) {
    const candidate = output.url;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

export async function materializeGameplayProviderOutput(input: {
  rootCreativeRunId: string;
  generationId: string;
  shotId: string;
  assetType: "image" | "video";
  assetUrl: string;
  signal: AbortSignal;
}): Promise<{ driveFileId: string; driveWebUrl: string | null; mimeType: string }> {
  const data = await requestInspection<{
    archived: {
      driveFileId: string;
      driveWebUrl: string | null;
      mimeType: string;
    };
  }>(
    {
      action: "materialize",
      rootCreativeRunId: input.rootCreativeRunId,
      generationId: input.generationId,
      shotId: input.shotId,
      assetType: input.assetType,
      assetUrl: input.assetUrl,
    },
    input.signal,
  );
  if (!data.archived?.driveFileId) {
    throw new Error("GAMEPLAY_GENERATED_ASSET_MATERIALIZATION_RESPONSE_INVALID");
  }
  return data.archived;
}

export async function resolveInspectionDriveFileId(input: {
  rootCreativeRunId: string;
  generationId: string;
  shotId: string;
  assetType: "image" | "video";
  outputs: Array<Record<string, unknown>>;
  signal: AbortSignal;
}): Promise<string> {
  const existing = outputDriveFileId(input.outputs);
  if (existing) return existing;
  const assetUrl = outputProviderUrl(input.outputs);
  if (!assetUrl) throw new Error("GAMEPLAY_GENERATED_ASSET_OUTPUT_MISSING");
  const archived = await materializeGameplayProviderOutput({
    rootCreativeRunId: input.rootCreativeRunId,
    generationId: input.generationId,
    shotId: input.shotId,
    assetType: input.assetType,
    assetUrl,
    signal: input.signal,
  });
  return archived.driveFileId;
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
  let lastError: unknown;
  for (let attempt = 1; attempt <= VIDEO_INSPECTION_ATTEMPTS; attempt += 1) {
    try {
      const data = await requestInspection<{ inspection: unknown }>(
        { action: "video", ...input, signal: undefined },
        input.signal,
      );
      return gameplayVideoAuthenticityInspectionV1Schema.parse(data.inspection);
    } catch (error) {
      lastError = error;
      if (input.signal.aborted || attempt === VIDEO_INSPECTION_ATTEMPTS) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
