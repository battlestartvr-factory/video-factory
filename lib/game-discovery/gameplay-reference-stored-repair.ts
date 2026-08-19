import "server-only";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  GAMEPLAY_REFERENCE_CAPTION_MODEL,
  type GameplayReferenceCaptionResult,
  type GameplayReferenceCaptionUsage,
} from "./gameplay-reference-captioner";
import { findPerceptualNearDuplicate } from "./gameplay-reference-dedupe";
import {
  materializeGameplayReferenceSpec,
  parseGameplayReferenceCaption,
  type PendingGameplayReferenceIdentity,
} from "./gameplay-reference-indexing";
import type { GameplayReferenceSpecV1 } from "./gameplay-reference-schema";
import { persistIndexedGameplayReference } from "./gameplay-reference-service";

interface StoredCaptionRow {
  reference_id: string;
  game_id: string;
  game_name: string;
  media_type: "image" | "video_segment";
  source_type: PendingGameplayReferenceIdentity["sourceType"];
  source_url: string;
  source_timestamp_ms: number | string | null;
  captured_at: string | null;
  observed_at: string;
  drive_file_id: string;
  mime_type: string;
  width: number;
  height: number;
  duration_ms: number | string | null;
  content_sha256: string | null;
  perceptual_hash: string | null;
  canonical_reference_id: string | null;
  dedupe_reason: string | null;
  metadata: Record<string, unknown> | null;
  index_status: "pending_caption" | "indexed" | "failed";
  caption_model: string | null;
  caption_usage: Record<string, unknown> | null;
  caption_debug: Record<string, unknown> | null;
}

function nullableNumber(value: number | string | null): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function storedUsage(value: Record<string, unknown> | null): GameplayReferenceCaptionUsage {
  const source = value ?? {};
  return {
    promptTokens: usageNumber(source.promptTokens),
    completionTokens: usageNumber(source.completionTokens),
    totalTokens: usageNumber(source.totalTokens),
  };
}

function identityFromRow(row: StoredCaptionRow): PendingGameplayReferenceIdentity {
  return {
    referenceId: row.reference_id,
    gameId: row.game_id,
    gameName: row.game_name,
    mediaType: row.media_type,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    sourceTimestampMs: nullableNumber(row.source_timestamp_ms),
    capturedAt: row.captured_at,
    observedAt: new Date(row.observed_at).toISOString(),
    driveFileId: row.drive_file_id,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    durationMs: nullableNumber(row.duration_ms),
    contentSha256: row.content_sha256,
    perceptualHash: row.perceptual_hash,
    canonicalReferenceId: row.canonical_reference_id,
    dedupeReason: row.dedupe_reason,
    metadata: row.metadata ?? {},
  };
}

async function applySameGamePerceptualDedupe(
  identity: PendingGameplayReferenceIdentity,
): Promise<void> {
  if (!identity.perceptualHash) return;
  const supabase = createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("gameplay_references")
    .select("reference_id,perceptual_hash,canonical_reference_id")
    .eq("game_id", identity.gameId)
    .neq("reference_id", identity.referenceId)
    .not("perceptual_hash", "is", null);
  if (error) throw new Error(`GAMEPLAY_REFERENCE_DEDUPE_QUERY_FAILED:${error.message}`);

  const nearDuplicate = findPerceptualNearDuplicate({
    referenceId: identity.referenceId,
    perceptualHash: identity.perceptualHash,
    candidates: (data ?? []).map((row) => ({
      referenceId: String(row.reference_id),
      perceptualHash: typeof row.perceptual_hash === "string" ? row.perceptual_hash : null,
      canonicalReferenceId:
        typeof row.canonical_reference_id === "string" ? row.canonical_reference_id : null,
    })),
  });
  if (!nearDuplicate) return;
  identity.canonicalReferenceId = nearDuplicate.canonicalReferenceId;
  identity.dedupeReason = `perceptual_hash_hamming_distance:${nearDuplicate.distance}`;
}

/**
 * Reprocesses a previously paid caption from its bounded stored raw response. This path must
 * never contact the vision provider. It exists so deterministic schema fixes do not trigger
 * another model call for the same evidence.
 */
export async function repairGameplayReferenceFromStoredCaption(
  referenceId: string,
): Promise<GameplayReferenceSpecV1 | null> {
  const supabase = createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("gameplay_references")
    .select(
      "reference_id,game_id,game_name,media_type,source_type,source_url,source_timestamp_ms,captured_at,observed_at,drive_file_id,mime_type,width,height,duration_ms,content_sha256,perceptual_hash,canonical_reference_id,dedupe_reason,metadata,index_status,caption_model,caption_usage,caption_debug",
    )
    .eq("reference_id", referenceId)
    .single();
  if (error || !data) return null;

  const row = data as StoredCaptionRow;
  if (row.index_status !== "failed") return null;
  const rawResponse = row.caption_debug?.rawResponse;
  if (typeof rawResponse !== "string" || !rawResponse.trim()) return null;

  let caption;
  try {
    caption = parseGameplayReferenceCaption(rawResponse);
  } catch (parseError) {
    const detail = parseError instanceof Error ? parseError.message : String(parseError);
    throw new Error(`GAMEPLAY_REFERENCE_STORED_CAPTION_STILL_INVALID:${detail}`);
  }

  const identity = identityFromRow(row);
  await applySameGamePerceptualDedupe(identity);
  const spec = materializeGameplayReferenceSpec({ identity, caption });
  const captionResult: GameplayReferenceCaptionResult = {
    caption,
    model: row.caption_model ?? GAMEPLAY_REFERENCE_CAPTION_MODEL,
    usage: storedUsage(row.caption_usage),
  };
  await persistIndexedGameplayReference({ spec, caption: captionResult });
  return spec;
}
