import "server-only";
import { createHash } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getDriveStorageProvider } from "@/lib/storage/drive-provider";
import type {
  CoopGameConceptSpecV1,
  GameplayMomentSpecV1,
  ShotSpecV1,
} from "./schemas";
import {
  buildGameplayReferenceNeed,
  retrieveGameplayReferences,
} from "./gameplay-reference-retrieval";
import { getGameplayReferenceCandidates } from "./gameplay-reference-service";
import {
  stage4GameplayReferenceProviderAssetSchema,
  stage4GameplayReferenceSetSchema,
  toStage4GameplayReferenceSet,
  type Stage4GameplayReferenceProviderAsset,
  type Stage4GameplayReferenceSet,
} from "./gameplay-reference-stage4";

const CACHE_BUCKET = "generator-inputs";
const SIGNED_URL_TTL_SECONDS = 48 * 60 * 60;

function safeFilename(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.replace(/^-+|-+$/g, "").slice(0, 120) || "gameplay-reference";
}

function fileExtension(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    default:
      return "";
  }
}

function referenceCachePath(input: {
  referenceId: string;
  driveFileId: string;
  filename: string;
  mimeType: string;
}): string {
  const identity = createHash("sha256")
    .update(`${input.referenceId}:${input.driveFileId}`)
    .digest("hex")
    .slice(0, 24);
  const extension = fileExtension(input.mimeType);
  const filename = safeFilename(input.filename).replace(/\.[a-zA-Z0-9]{1,8}$/, "");
  return `system/gameplay-reference-cache/v1/${input.referenceId}/${identity}-${filename}${extension}`;
}

export async function retrieveStage4GameplayReferences(input: {
  concept: CoopGameConceptSpecV1;
  moment: GameplayMomentSpecV1;
  shot: ShotSpecV1;
}): Promise<Stage4GameplayReferenceSet> {
  const need = buildGameplayReferenceNeed({
    moment: input.moment,
    shot: input.shot,
    mechanicTags: input.concept.interactionModel,
    interactionModel: input.concept.interactionModel,
    productionScopeFeel: ["indie", "AA"],
    maxResults: 8,
  });
  const candidates = await getGameplayReferenceCandidates({ need, candidateLimit: 80 });
  const selected = retrieveGameplayReferences({ need, candidates });
  if (selected.references.length < 4) {
    throw new Error(
      `GAMEPLAY_REFERENCE_SET_INSUFFICIENT:${selected.references.length}:need_at_least_4`,
    );
  }
  return toStage4GameplayReferenceSet(selected);
}

export async function materializeStage4GameplayReferences(
  rawSet: Stage4GameplayReferenceSet,
): Promise<Stage4GameplayReferenceProviderAsset[]> {
  const set = stage4GameplayReferenceSetSchema.parse(rawSet);
  const drive = getDriveStorageProvider();
  const supabase = createSupabaseServiceClient();
  const assets: Stage4GameplayReferenceProviderAsset[] = [];

  for (const item of set.references) {
    const metadata = await drive.getFileMetadata(item.driveFileId);
    if (!metadata.mimeType.startsWith("image/")) {
      throw new Error(`GAMEPLAY_REFERENCE_PROVIDER_MEDIA_UNSUPPORTED:${item.referenceId}`);
    }
    const buffer = await drive.downloadFile(item.driveFileId);
    const path = referenceCachePath({
      referenceId: item.referenceId,
      driveFileId: item.driveFileId,
      filename: metadata.filename,
      mimeType: metadata.mimeType,
    });

    const { error: uploadError } = await supabase.storage.from(CACHE_BUCKET).upload(path, buffer, {
      contentType: metadata.mimeType,
      cacheControl: "3600",
      upsert: true,
    });
    if (uploadError) {
      throw new Error(`GAMEPLAY_REFERENCE_PROVIDER_CACHE_UPLOAD_FAILED:${uploadError.message}`);
    }

    const { data: signed, error: signedError } = await supabase.storage
      .from(CACHE_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (signedError || !signed?.signedUrl) {
      throw new Error(
        `GAMEPLAY_REFERENCE_PROVIDER_SIGNED_URL_FAILED:${signedError?.message ?? item.referenceId}`,
      );
    }

    assets.push(
      stage4GameplayReferenceProviderAssetSchema.parse({
        id: item.referenceId,
        url: signed.signedUrl,
        role: item.purpose,
        mimeType: metadata.mimeType,
        filename: metadata.filename,
      }),
    );
  }

  return assets;
}
