import { randomUUID } from "node:crypto";
import type { ImageSearchResult, SearchFreshnessIntent, WebDocument, WebImage } from "@/lib/web";
import type { DurableImageGeneration } from "@/lib/orchestrator/generation-images";
import type { ResearchToolbox } from "./toolbox";
import {
  externalVisualReferenceRoleSchema,
  externalVisualReferenceSpecV1Schema,
  imageReferenceSetSpecV1Schema,
  type ExternalVisualReferenceSpecV1,
  type ImageReferenceSetSpecV1,
} from "./schemas";

export const WEB_VISUAL_REFERENCE_MAX_CANDIDATES = 24;
export const WEB_VISUAL_REFERENCE_DEFAULT_SELECTED = 4;
export const WEB_VISUAL_REFERENCE_PHASH_MAX_DISTANCE = 6;

export interface ExternalVisualArchiveResult {
  driveFileId: string;
  driveWebUrl?: string | null;
  filename: string;
  mimeType: string;
  sizeBytes?: number | null;
  archivedAt: string;
}

export interface ExternalVisualArchive {
  archive(input: {
    researchRunId: string;
    referenceId: string;
    sourceUrl: string;
    imageUrl: string;
    image: WebImage;
    signal?: AbortSignal;
  }): Promise<ExternalVisualArchiveResult>;
}

export interface ExternalVisualFingerprint {
  referenceId: string;
  contentSha256: string;
  perceptualHash?: string;
}

export interface ExternalVisualReferenceRepository {
  registerSource(input: {
    researchRunId: string;
    source: WebDocument;
    query: string;
    searchResult: ImageSearchResult;
  }): Promise<string>;
  listFingerprints(researchRunId: string): Promise<ExternalVisualFingerprint[]>;
  persistReference(input: {
    reference: ExternalVisualReferenceSpecV1;
    archive: ExternalVisualArchiveResult;
    searchMetadata?: Record<string, unknown>;
  }): Promise<{ duplicate: boolean; reference: ExternalVisualReferenceSpecV1 }>;
  persistReferenceSet?(input: {
    referenceSet: ImageReferenceSetSpecV1;
    providerModel: string;
    providerLimit: number;
    lineage: CompiledImageReferenceLineage;
    referenceAssets: CompiledImageReferenceAsset[];
  }): Promise<void>;
}

export interface PerceptualHashResolver {
  resolve(input: { image: WebImage; searchResult: ImageSearchResult }): Promise<string | undefined>;
}

export interface DiscoverExternalVisualReferencesInput {
  researchRunId: string;
  query: string;
  roles: Array<
    | "gameplay_grammar"
    | "environment_object"
    | "composition"
    | "art_direction"
    | "ui_affordance"
    | "negative_reference"
  >;
  whyRelevant: string;
  mustNotCopy?: string[];
  trust?: "preferred" | "normal" | "low";
  freshness?: SearchFreshnessIntent;
  maxCandidates?: number;
  maxSelected?: number;
  domainAllowlist?: string[];
  domainDenylist?: string[];
  signal?: AbortSignal;
}

export interface ExternalVisualReferenceRejection {
  imageUrl: string;
  sourceUrl?: string;
  reason:
    | "missing_source_provenance"
    | "source_fetch_failed"
    | "image_fetch_failed"
    | "exact_duplicate"
    | "perceptual_near_duplicate"
    | "archive_failed";
  duplicateOfReferenceId?: string;
  error?: string;
}

export interface DiscoverExternalVisualReferencesResult {
  query: string;
  searchedCandidates: number;
  selected: ExternalVisualReferenceSpecV1[];
  rejected: ExternalVisualReferenceRejection[];
}

function normalizedHash(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  return /^[a-f0-9]{8,256}$/.test(normalized) ? normalized : undefined;
}

function providerPerceptualHash(result: ImageSearchResult): string | undefined {
  return normalizedHash(
    result.providerMetadata?.perceptualHash ??
      result.providerMetadata?.perceptual_hash ??
      result.providerMetadata?.pHash ??
      result.providerMetadata?.phash,
  );
}

const NIBBLE_BITS = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4] as const;

export function hammingDistanceHex(left: string, right: string): number | null {
  const a = normalizedHash(left);
  const b = normalizedHash(right);
  if (!a || !b || a.length !== b.length) return null;
  let distance = 0;
  for (let index = 0; index < a.length; index += 1) {
    const xor = Number.parseInt(a[index]!, 16) ^ Number.parseInt(b[index]!, 16);
    distance += NIBBLE_BITS[xor]!;
  }
  return distance;
}

export function findVisualDuplicate(input: {
  contentSha256: string;
  perceptualHash?: string;
  existing: ExternalVisualFingerprint[];
  maxPerceptualDistance?: number;
}): { kind: "exact" | "perceptual"; referenceId: string } | null {
  const exact = input.existing.find(
    (item) => item.contentSha256.toLowerCase() === input.contentSha256.toLowerCase(),
  );
  if (exact) return { kind: "exact", referenceId: exact.referenceId };

  const perceptualHash = normalizedHash(input.perceptualHash);
  if (!perceptualHash) return null;
  const maxDistance = input.maxPerceptualDistance ?? WEB_VISUAL_REFERENCE_PHASH_MAX_DISTANCE;
  for (const item of input.existing) {
    if (!item.perceptualHash) continue;
    const distance = hammingDistanceHex(perceptualHash, item.perceptualHash);
    if (distance !== null && distance <= maxDistance) {
      return { kind: "perceptual", referenceId: item.referenceId };
    }
  }
  return null;
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value!)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function discoverExternalVisualReferences(input: {
  toolbox: ResearchToolbox;
  repository: ExternalVisualReferenceRepository;
  archive: ExternalVisualArchive;
  perceptualHashResolver?: PerceptualHashResolver;
  request: DiscoverExternalVisualReferencesInput;
}): Promise<DiscoverExternalVisualReferencesResult> {
  const request = input.request;
  if (request.signal?.aborted) throw new Error("WEB_VISUAL_REFERENCE_DISCOVERY_ABORTED");
  const roles = request.roles.map((role) => externalVisualReferenceRoleSchema.parse(role));
  const maxCandidates = boundedInt(
    request.maxCandidates,
    8,
    1,
    WEB_VISUAL_REFERENCE_MAX_CANDIDATES,
  );
  const maxSelected = boundedInt(
    request.maxSelected,
    WEB_VISUAL_REFERENCE_DEFAULT_SELECTED,
    1,
    Math.min(8, maxCandidates),
  );
  const search = await input.toolbox.searchImages({
    query: request.query,
    freshness: request.freshness ?? "mixed",
    maxResults: maxCandidates,
    domainAllowlist: request.domainAllowlist,
    domainDenylist: request.domainDenylist,
  });
  const candidates = search.value.slice(0, maxCandidates);
  const selected: ExternalVisualReferenceSpecV1[] = [];
  const rejected: ExternalVisualReferenceRejection[] = [];
  const fingerprints = await input.repository.listFingerprints(request.researchRunId);

  for (const candidate of candidates) {
    if (selected.length >= maxSelected) break;
    if (request.signal?.aborted) throw new Error("WEB_VISUAL_REFERENCE_DISCOVERY_ABORTED");

    const sourceUrl = candidate.canonicalSourceUrl ?? candidate.sourceUrl;
    if (!sourceUrl) {
      rejected.push({ imageUrl: candidate.imageUrl, reason: "missing_source_provenance" });
      continue;
    }

    let sourceResult;
    try {
      sourceResult = await input.toolbox.fetchSource({
        url: sourceUrl,
        query: request.query,
        freshness: request.freshness ?? "mixed",
      });
    } catch (error) {
      rejected.push({
        imageUrl: candidate.imageUrl,
        sourceUrl,
        reason: "source_fetch_failed",
        error: errorMessage(error),
      });
      continue;
    }

    const sourceId = await input.repository.registerSource({
      researchRunId: request.researchRunId,
      source: sourceResult.document,
      query: request.query,
      searchResult: candidate,
    });

    let imageResult;
    try {
      imageResult = await input.toolbox.fetchImage({
        url: candidate.canonicalImageUrl ?? candidate.imageUrl,
        freshness: request.freshness ?? "mixed",
      });
    } catch (error) {
      rejected.push({
        imageUrl: candidate.imageUrl,
        sourceUrl,
        reason: "image_fetch_failed",
        error: errorMessage(error),
      });
      continue;
    }

    const image = imageResult.image;
    const perceptualHash = normalizedHash(
      (await input.perceptualHashResolver?.resolve({ image, searchResult: candidate })) ??
        providerPerceptualHash(candidate),
    );
    const duplicate = findVisualDuplicate({
      contentSha256: image.contentSha256,
      perceptualHash,
      existing: fingerprints,
    });
    if (duplicate) {
      rejected.push({
        imageUrl: candidate.imageUrl,
        sourceUrl,
        reason: duplicate.kind === "exact" ? "exact_duplicate" : "perceptual_near_duplicate",
        duplicateOfReferenceId: duplicate.referenceId,
      });
      continue;
    }

    const referenceId = randomUUID();
    let archive;
    try {
      archive = await input.archive.archive({
        researchRunId: request.researchRunId,
        referenceId,
        sourceUrl: sourceResult.document.canonicalUrl ?? sourceResult.document.url,
        imageUrl: image.canonicalUrl,
        image,
        signal: request.signal,
      });
    } catch (error) {
      rejected.push({
        imageUrl: candidate.imageUrl,
        sourceUrl,
        reason: "archive_failed",
        error: errorMessage(error),
      });
      continue;
    }

    const reference = externalVisualReferenceSpecV1Schema.parse({
      schema: "external_visual_reference",
      version: 1,
      referenceId,
      researchRunId: request.researchRunId,
      sourceId,
      sourceUrl: sourceResult.document.canonicalUrl ?? sourceResult.document.url,
      imageUrl: image.canonicalUrl,
      observedAt: image.observedAt,
      driveFileId: archive.driveFileId,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      contentSha256: image.contentSha256,
      ...(perceptualHash ? { perceptualHash } : {}),
      roles,
      whyRelevant: request.whyRelevant,
      mustNotCopy: request.mustNotCopy ?? [],
      trust: request.trust ?? "normal",
      metadata: {
        external_reference: true,
        generated_asset: false,
        gameplay_library_entry: false,
        search_query: request.query,
        search_title: candidate.title,
        search_domain: candidate.domain,
        search_cache_key: search.cacheKey,
        search_reused_from_cache: search.reusedFromCache,
        source_reused_from_cache: sourceResult.reusedFromCache,
        image_reused_from_cache: imageResult.reusedFromCache,
        archive_filename: archive.filename,
        archive_mime_type: archive.mimeType,
        archive_size_bytes: archive.sizeBytes ?? null,
        archive_web_url: archive.driveWebUrl ?? null,
        archived_at: archive.archivedAt,
      },
    });

    const persisted = await input.repository.persistReference({
      reference,
      archive,
      searchMetadata: candidate.providerMetadata,
    });
    const finalReference = persisted.reference;
    selected.push(finalReference);
    fingerprints.push({
      referenceId: finalReference.referenceId,
      contentSha256: finalReference.contentSha256,
      ...(finalReference.perceptualHash ? { perceptualHash: finalReference.perceptualHash } : {}),
    });
  }

  return {
    query: request.query,
    searchedCandidates: candidates.length,
    selected,
    rejected,
  };
}

const EXTERNAL_ROLE_PRIORITY: Record<ExternalVisualReferenceSpecV1["roles"][number], number> = {
  gameplay_grammar: 100,
  environment_object: 80,
  ui_affordance: 75,
  composition: 65,
  negative_reference: 60,
  art_direction: 50,
};

function strongestRole(reference: ExternalVisualReferenceSpecV1): ExternalVisualReferenceSpecV1["roles"][number] {
  return [...reference.roles].sort(
    (left, right) => EXTERNAL_ROLE_PRIORITY[right] - EXTERNAL_ROLE_PRIORITY[left],
  )[0]!;
}

export function curateExternalImageReferenceSet(input: {
  conceptId: string;
  momentId?: string;
  researchRunId: string;
  externalReferences: ExternalVisualReferenceSpecV1[];
  maxReferences?: number;
  targetReferences?: number;
  selectionRationale?: string;
}): ImageReferenceSetSpecV1 {
  const maxReferences = boundedInt(input.maxReferences, 4, 1, 16);
  const targetReferences = boundedInt(
    input.targetReferences,
    Math.min(WEB_VISUAL_REFERENCE_DEFAULT_SELECTED, maxReferences),
    1,
    maxReferences,
  );
  const eligible = input.externalReferences
    .map((reference) => externalVisualReferenceSpecV1Schema.parse(reference))
    .filter(
      (reference) =>
        reference.researchRunId === input.researchRunId && Boolean(reference.driveFileId),
    )
    .sort((left, right) => {
      const roleDelta = EXTERNAL_ROLE_PRIORITY[strongestRole(right)] - EXTERNAL_ROLE_PRIORITY[strongestRole(left)];
      if (roleDelta !== 0) return roleDelta;
      const trustWeight = { preferred: 3, normal: 2, low: 1 } as const;
      return trustWeight[right.trust] - trustWeight[left.trust];
    })
    .slice(0, targetReferences);

  if (!eligible.length) throw new Error("IMAGE_REFERENCE_SET_NO_EXTERNAL_REFERENCES");
  const references = eligible.map((reference, index) => {
    const role = strongestRole(reference);
    return {
      referenceId: reference.referenceId,
      origin: "external_research" as const,
      role,
      priority: Math.max(1, 100 - index * 10),
      intendedUse: reference.whyRelevant,
      mustNotCopy: reference.mustNotCopy,
    };
  });

  return imageReferenceSetSpecV1Schema.parse({
    schema: "image_reference_set",
    version: 1,
    conceptId: input.conceptId,
    ...(input.momentId ? { momentId: input.momentId } : {}),
    researchRunId: input.researchRunId,
    references,
    selectionRationale:
      input.selectionRationale ??
      "Prefer a small set of source-grounded references: gameplay grammar and mechanic legibility before environment/object reality, composition, and aesthetic polish.",
  });
}

export interface CompiledImageReferenceAsset {
  id: string;
  url: string;
  mimeType: string;
  filename: string;
  role: string;
  origin: "gameplay_library" | "external_research";
}

export interface CompiledImageReferenceLineage {
  schema: "compiled_image_reference_lineage";
  version: 1;
  conceptId: string;
  momentId?: string;
  researchRunId?: string;
  providerModel: string;
  selectedReferenceIds: string[];
  references: Array<{
    referenceId: string;
    origin: "gameplay_library" | "external_research";
    role: string;
    intendedUse: string;
    mustNotCopy: string[];
  }>;
}

export interface CompiledImageReferenceInput {
  referenceAssets: CompiledImageReferenceAsset[];
  providerInputPatch: Record<string, unknown>;
  promptInstructionBlock: string;
  lineage: CompiledImageReferenceLineage;
  providerLimit: number;
}

export function providerImageReferenceLimit(modelId: string): number {
  switch (modelId) {
    case "gpt-image-2":
    case "nano-banana-pro":
      return 4;
    case "nano-banana-2":
      return 8;
    default:
      throw new Error(`IMAGE_REFERENCE_PROVIDER_UNSUPPORTED:${modelId}`);
  }
}

export function compileImageReferenceSetForProvider(input: {
  providerModel: string;
  referenceSet: ImageReferenceSetSpecV1;
  assets: CompiledImageReferenceAsset[];
}): CompiledImageReferenceInput {
  const set = imageReferenceSetSpecV1Schema.parse(input.referenceSet);
  const providerLimit = providerImageReferenceLimit(input.providerModel);
  if (set.references.length > providerLimit) {
    throw new Error(`IMAGE_REFERENCE_SET_PROVIDER_LIMIT:${set.references.length}:${providerLimit}`);
  }
  const assetById = new Map(input.assets.map((asset) => [asset.id, asset]));
  const orderedAssets = set.references.map((selected) => {
    const asset = assetById.get(selected.referenceId);
    if (!asset) throw new Error(`IMAGE_REFERENCE_ASSET_MISSING:${selected.referenceId}`);
    if (asset.origin !== selected.origin) {
      throw new Error(`IMAGE_REFERENCE_ORIGIN_MISMATCH:${selected.referenceId}`);
    }
    if (!asset.url.startsWith("https://")) {
      throw new Error(`IMAGE_REFERENCE_PROVIDER_URL_UNSAFE:${selected.referenceId}`);
    }
    return asset;
  });
  const urls = orderedAssets.map((asset) => asset.url);
  const providerInputPatch =
    input.providerModel === "gpt-image-2" ? { input_urls: urls } : { image_input: urls };
  const promptInstructionBlock = set.references
    .map(
      (reference, index) =>
        `Reference ${index + 1} (${reference.role}, ${reference.origin}): ${reference.intendedUse} Must not copy: ${reference.mustNotCopy.join("; ") || "identity, branding, characters, or composition verbatim"}.`,
    )
    .join("\n");
  const lineage: CompiledImageReferenceLineage = {
    schema: "compiled_image_reference_lineage",
    version: 1,
    conceptId: set.conceptId,
    ...(set.momentId ? { momentId: set.momentId } : {}),
    ...(set.researchRunId ? { researchRunId: set.researchRunId } : {}),
    providerModel: input.providerModel,
    selectedReferenceIds: set.references.map((reference) => reference.referenceId),
    references: set.references.map((reference) => ({
      referenceId: reference.referenceId,
      origin: reference.origin,
      role: reference.role,
      intendedUse: reference.intendedUse,
      mustNotCopy: reference.mustNotCopy,
    })),
  };
  return { referenceAssets: orderedAssets, providerInputPatch, promptInstructionBlock, lineage, providerLimit };
}

export function applyCompiledReferencesToGeneration(input: {
  generation: DurableImageGeneration;
  compiled: CompiledImageReferenceInput;
}): DurableImageGeneration {
  return {
    ...input.generation,
    prompt: `${input.generation.prompt}\n\nEXTERNAL / GAMEPLAY REFERENCE INSTRUCTIONS:\n${input.compiled.promptInstructionBlock}\n\nREFERENCE FIREWALL: use references only for their labeled purpose. Never copy source identity, branding, characters, proprietary UI, or composition verbatim.`,
    referenceAssets: input.compiled.referenceAssets.map((asset) => ({
      id: asset.id,
      url: asset.url,
      mimeType: asset.mimeType,
      filename: asset.filename,
      role: asset.role,
    })),
    settings: {
      ...input.generation.settings,
      imageReferenceLineage: input.compiled.lineage,
      image_reference_lineage: input.compiled.lineage,
    },
  };
}
