import "server-only";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getDriveStorageProvider, type DriveStorageProvider } from "@/lib/storage/drive-provider";
import {
  captionGameplayReferenceImage,
  type GameplayReferenceCaptionResult,
} from "./gameplay-reference-captioner";
import { findPerceptualNearDuplicate } from "./gameplay-reference-dedupe";
import {
  materializeGameplayReferenceSpec,
  type PendingGameplayReferenceIdentity,
} from "./gameplay-reference-indexing";
import type { GameplayReferenceSpecV1 } from "./gameplay-reference-schema";
import type {
  GameplayReferenceCandidate,
  GameplayReferenceNeedSpecV1,
} from "./gameplay-reference-retrieval";

interface PendingReferenceRow {
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
}

function nullableNumber(value: number | string | null): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pendingIdentity(row: PendingReferenceRow): PendingGameplayReferenceIdentity {
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

function specUpdate(spec: GameplayReferenceSpecV1, caption: GameplayReferenceCaptionResult) {
  return {
    camera_type: spec.cameraType,
    camera_distance: spec.cameraDistance ?? null,
    camera_height: spec.cameraHeight ?? null,
    fov_estimate: spec.fovEstimate ?? null,
    playable_character_visible: spec.playableCharacterVisible ?? null,
    hands_visible: spec.handsVisible ?? null,
    held_tool_visible: spec.heldToolVisible ?? null,
    crosshair_visible: spec.crosshairVisible ?? null,
    hud_visible: spec.hudVisible ?? null,
    controllable_player_obvious: spec.controllablePlayerObvious,
    how_player_control_is_visible: spec.howPlayerControlIsVisible,
    current_player_action: spec.currentPlayerAction,
    visible_input_affordance: spec.visibleInputAffordance,
    player_target: spec.playerTarget ?? null,
    game_response: spec.gameResponse,
    teammate_count_visible: spec.teammateCountVisible,
    teammate_distance: spec.teammateDistance ?? null,
    teammate_role: spec.teammateRole ?? null,
    coop_dependency_visible: spec.coopDependencyVisible,
    shared_object_visible: spec.sharedObjectVisible,
    information_asymmetry_visible: spec.informationAsymmetryVisible,
    rescue_visible: spec.rescueVisible,
    coordination_visible: spec.coordinationVisible,
    core_action: spec.coreAction,
    mechanic_tags: spec.mechanicTags,
    interaction_model: spec.interactionModel,
    danger_source: spec.dangerSource ?? null,
    failure_risk: spec.failureRisk ?? null,
    success_state: spec.successState ?? null,
    physics_interaction: spec.physicsInteraction ?? null,
    environment_type: spec.environmentType ?? null,
    primary_focus: spec.primaryFocus,
    secondary_focus: spec.secondaryFocus ?? null,
    readable_without_context: spec.readableWithoutContext,
    visible_goal: spec.visibleGoal,
    visible_risk: spec.visibleRisk,
    ui_supports_action: spec.uiSupportsAction,
    visual_clutter: spec.visualClutter,
    art_direction: spec.artDirection,
    realism_level: spec.realismLevel,
    production_scope_feel: spec.productionScopeFeel,
    stylization_tags: spec.stylizationTags,
    gameplay_description: spec.gameplayDescription,
    why_this_looks_like_gameplay: spec.whyThisLooksLikeGameplay,
    canonical_reference_id: spec.canonicalReferenceId ?? null,
    dedupe_reason: spec.dedupeReason ?? null,
    caption_model: caption.model,
    caption_usage: {
      ...caption.usage,
      modelCalls: 1,
      schemaRepairModelCalls: 0,
      normalization: "deterministic",
    },
    index_status: "indexed",
    index_error: null,
    indexed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export async function getPendingGameplayReference(referenceId: string): Promise<PendingReferenceRow> {
  const supabase = createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("gameplay_references")
    .select(
      "reference_id,game_id,game_name,media_type,source_type,source_url,source_timestamp_ms,captured_at,observed_at,drive_file_id,mime_type,width,height,duration_ms,content_sha256,perceptual_hash,canonical_reference_id,dedupe_reason,metadata,index_status",
    )
    .eq("reference_id", referenceId)
    .single();
  if (error || !data) {
    throw new Error(`GAMEPLAY_REFERENCE_NOT_FOUND:${referenceId}`);
  }
  return data as PendingReferenceRow;
}

async function findNearDuplicateIdentity(identity: PendingGameplayReferenceIdentity) {
  if (!identity.perceptualHash) return null;
  const supabase = createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("gameplay_references")
    .select("reference_id,perceptual_hash,canonical_reference_id")
    .neq("reference_id", identity.referenceId)
    .not("perceptual_hash", "is", null);
  if (error) throw new Error(`GAMEPLAY_REFERENCE_DEDUPE_QUERY_FAILED:${error.message}`);
  return findPerceptualNearDuplicate({
    referenceId: identity.referenceId,
    perceptualHash: identity.perceptualHash,
    candidates: (data ?? []).map((row) => ({
      referenceId: String(row.reference_id),
      perceptualHash: typeof row.perceptual_hash === "string" ? row.perceptual_hash : null,
      canonicalReferenceId:
        typeof row.canonical_reference_id === "string" ? row.canonical_reference_id : null,
    })),
  });
}

export async function persistIndexedGameplayReference(input: {
  spec: GameplayReferenceSpecV1;
  caption: GameplayReferenceCaptionResult;
}): Promise<void> {
  const supabase = createSupabaseServiceClient();
  const { error } = await supabase
    .from("gameplay_references")
    .update(specUpdate(input.spec, input.caption))
    .eq("reference_id", input.spec.referenceId);
  if (error) throw new Error(`GAMEPLAY_REFERENCE_INDEX_WRITE_FAILED:${error.message}`);
}

export async function markGameplayReferenceIndexFailed(input: {
  referenceId: string;
  error: unknown;
}): Promise<void> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const supabase = createSupabaseServiceClient();
  const { error } = await supabase
    .from("gameplay_references")
    .update({
      index_status: "failed",
      index_error: message.slice(0, 2_000),
      updated_at: new Date().toISOString(),
    })
    .eq("reference_id", input.referenceId);
  if (error) throw new Error(`GAMEPLAY_REFERENCE_INDEX_FAILURE_WRITE_FAILED:${error.message}`);
}

export async function indexGameplayReference(input: {
  referenceId: string;
  drive?: DriveStorageProvider;
  caption?: typeof captionGameplayReferenceImage;
}): Promise<GameplayReferenceSpecV1> {
  const row = await getPendingGameplayReference(input.referenceId);
  if (row.index_status === "indexed") {
    throw new Error(`GAMEPLAY_REFERENCE_ALREADY_INDEXED:${input.referenceId}`);
  }
  if (row.media_type !== "image") {
    throw new Error(`GAMEPLAY_REFERENCE_CAPTION_MEDIA_UNSUPPORTED:${row.media_type}`);
  }

  const drive = input.drive ?? getDriveStorageProvider();
  const captionImage = input.caption ?? captionGameplayReferenceImage;

  try {
    const [buffer, metadata] = await Promise.all([
      drive.downloadFile(row.drive_file_id),
      drive.getFileMetadata(row.drive_file_id),
    ]);
    const caption = await captionImage({
      referenceId: row.reference_id,
      gameName: row.game_name,
      filename: metadata.filename,
      mimeType: row.mime_type,
      buffer,
    });

    const identity = pendingIdentity(row);
    const nearDuplicate = await findNearDuplicateIdentity(identity);
    if (nearDuplicate) {
      identity.canonicalReferenceId = nearDuplicate.canonicalReferenceId;
      identity.dedupeReason = `perceptual_hash_hamming_distance:${nearDuplicate.distance}`;
    }

    const spec = materializeGameplayReferenceSpec({ identity, caption: caption.caption });
    await persistIndexedGameplayReference({ spec, caption });
    return spec;
  } catch (error) {
    await markGameplayReferenceIndexFailed({ referenceId: row.reference_id, error }).catch(() => undefined);
    throw error;
  }
}

export async function listPendingGameplayReferenceIds(limit = 24): Promise<string[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const supabase = createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("gameplay_references")
    .select("reference_id")
    .eq("index_status", "pending_caption")
    .order("created_at", { ascending: true })
    .limit(safeLimit);
  if (error) throw new Error(`GAMEPLAY_REFERENCE_PENDING_QUERY_FAILED:${error.message}`);
  return (data ?? []).map((row) => String(row.reference_id));
}

interface CandidateRow {
  reference_id: string;
  game_id: string;
  game_name: string;
  drive_file_id: string;
  source_url: string;
  camera_type: GameplayReferenceCandidate["cameraType"];
  controllable_player_obvious: boolean;
  hands_visible: boolean | null;
  held_tool_visible: boolean | null;
  crosshair_visible: boolean | null;
  hud_visible: boolean | null;
  teammate_count_visible: number;
  coop_dependency_visible: boolean;
  shared_object_visible: boolean;
  coordination_visible: boolean;
  core_action: string;
  current_player_action: string;
  visible_input_affordance: string;
  game_response: string;
  mechanic_tags: string[];
  interaction_model: string[];
  failure_risk: string | null;
  danger_source: string | null;
  physics_interaction: string | null;
  readable_without_context: boolean;
  visible_goal: boolean;
  visible_risk: boolean;
  ui_supports_action: boolean;
  production_scope_feel: GameplayReferenceCandidate["productionScopeFeel"];
  stylization_tags: string[];
  art_direction: string;
  gameplay_description: string;
  why_this_looks_like_gameplay: string;
}

function candidateFromRow(row: CandidateRow, semanticSimilarity?: number | null): GameplayReferenceCandidate {
  return {
    referenceId: row.reference_id,
    gameId: row.game_id,
    gameName: row.game_name,
    driveFileId: row.drive_file_id,
    sourceUrl: row.source_url,
    cameraType: row.camera_type,
    controllablePlayerObvious: row.controllable_player_obvious,
    handsVisible: row.hands_visible,
    heldToolVisible: row.held_tool_visible,
    crosshairVisible: row.crosshair_visible,
    hudVisible: row.hud_visible,
    teammateCountVisible: row.teammate_count_visible,
    coopDependencyVisible: row.coop_dependency_visible,
    sharedObjectVisible: row.shared_object_visible,
    coordinationVisible: row.coordination_visible,
    coreAction: row.core_action,
    currentPlayerAction: row.current_player_action,
    visibleInputAffordance: row.visible_input_affordance,
    gameResponse: row.game_response,
    mechanicTags: row.mechanic_tags,
    interactionModel: row.interaction_model,
    failureRisk: row.failure_risk,
    dangerSource: row.danger_source,
    physicsInteraction: row.physics_interaction,
    readableWithoutContext: row.readable_without_context,
    visibleGoal: row.visible_goal,
    visibleRisk: row.visible_risk,
    uiSupportsAction: row.ui_supports_action,
    productionScopeFeel: row.production_scope_feel,
    stylizationTags: row.stylization_tags,
    artDirection: row.art_direction,
    gameplayDescription: row.gameplay_description,
    whyThisLooksLikeGameplay: row.why_this_looks_like_gameplay,
    semanticSimilarity: semanticSimilarity ?? null,
  };
}

const CANDIDATE_COLUMNS =
  "reference_id,game_id,game_name,drive_file_id,source_url,camera_type,controllable_player_obvious,hands_visible,held_tool_visible,crosshair_visible,hud_visible,teammate_count_visible,coop_dependency_visible,shared_object_visible,coordination_visible,core_action,current_player_action,visible_input_affordance,game_response,mechanic_tags,interaction_model,failure_risk,danger_source,physics_interaction,readable_without_context,visible_goal,visible_risk,ui_supports_action,production_scope_feel,stylization_tags,art_direction,gameplay_description,why_this_looks_like_gameplay";

export async function getGameplayReferenceCandidates(input: {
  need: GameplayReferenceNeedSpecV1;
  queryEmbedding?: number[] | null;
  candidateLimit?: number;
}): Promise<GameplayReferenceCandidate[]> {
  const supabase = createSupabaseServiceClient();
  const limit = Math.min(Math.max(input.candidateLimit ?? 40, 8), 120);

  if (input.queryEmbedding?.length === 768) {
    const { data: matches, error: matchError } = await supabase.rpc(
      "match_gameplay_references_v1",
      {
        p_query_embedding: input.queryEmbedding,
        p_match_count: limit,
        p_camera_types: input.need.cameraTypes.length ? input.need.cameraTypes : null,
        p_production_scopes: input.need.productionScopeFeel.length
          ? input.need.productionScopeFeel
          : null,
        p_require_coop: input.need.requireCoopDependency ? true : null,
        p_require_shared_object: input.need.requireSharedObject ?? null,
        p_require_visible_risk: input.need.requireVisibleRisk ?? null,
        p_mechanic_tags: input.need.mechanicTags.length ? input.need.mechanicTags : null,
      },
    );
    if (matchError) throw new Error(`GAMEPLAY_REFERENCE_VECTOR_QUERY_FAILED:${matchError.message}`);
    const matchRows = (matches ?? []) as Array<{
      reference_id: string;
      semantic_similarity: number;
    }>;
    if (!matchRows.length) return [];
    const ids = matchRows.map((match) => match.reference_id);
    const scoreById = new Map(matchRows.map((match) => [match.reference_id, match.semantic_similarity]));
    const { data, error } = await supabase
      .from("gameplay_references")
      .select(CANDIDATE_COLUMNS)
      .in("reference_id", ids);
    if (error) throw new Error(`GAMEPLAY_REFERENCE_CANDIDATE_QUERY_FAILED:${error.message}`);
    return ((data ?? []) as unknown as CandidateRow[])
      .map((row) => candidateFromRow(row, scoreById.get(row.reference_id) ?? null))
      .sort((a, b) => (b.semanticSimilarity ?? 0) - (a.semanticSimilarity ?? 0));
  }

  let query = supabase
    .from("gameplay_references")
    .select(CANDIDATE_COLUMNS)
    .eq("index_status", "indexed")
    .is("canonical_reference_id", null)
    .limit(limit);

  if (input.need.cameraTypes.length) query = query.in("camera_type", input.need.cameraTypes);
  if (input.need.productionScopeFeel.length) {
    query = query.in("production_scope_feel", input.need.productionScopeFeel);
  }
  if (input.need.requireCoopDependency) query = query.eq("coop_dependency_visible", true);
  if (input.need.requireSharedObject != null) {
    query = query.eq("shared_object_visible", input.need.requireSharedObject);
  }
  if (input.need.requireVisibleRisk != null) {
    query = query.eq("visible_risk", input.need.requireVisibleRisk);
  }

  const { data, error } = await query;
  if (error) throw new Error(`GAMEPLAY_REFERENCE_CANDIDATE_QUERY_FAILED:${error.message}`);
  return ((data ?? []) as unknown as CandidateRow[]).map((row) => candidateFromRow(row));
}
