import { createHash } from "node:crypto";
import type { OrchestratorRpcClient } from "@/lib/orchestrator/rpc";
import { requireRpcObject } from "@/lib/orchestrator/rpc";
import {
  externalVisualReferenceSpecV1Schema,
  imageReferenceSetSpecV1Schema,
  type ExternalVisualReferenceSpecV1,
} from "./schemas";
import type {
  CompiledImageReferenceAsset,
  CompiledImageReferenceLineage,
  ExternalVisualArchiveResult,
  ExternalVisualFingerprint,
  ExternalVisualReferenceRepository,
} from "./visual-references";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class RpcExternalVisualReferenceRepository implements ExternalVisualReferenceRepository {
  constructor(private readonly client: OrchestratorRpcClient) {}

  async registerSource(input: Parameters<ExternalVisualReferenceRepository["registerSource"]>[0]): Promise<string> {
    const canonicalUrl = input.source.canonicalUrl ?? input.source.url;
    const urlHash =
      input.source.urlSha256 ?? createHash("sha256").update(canonicalUrl).digest("hex");
    const { data, error } = await this.client.rpc("research_register_visual_source", {
      payload: {
        research_run_id: input.researchRunId,
        query: input.query,
        reused_from_cache: false,
        source: {
          canonical_url: canonicalUrl,
          url_hash: urlHash,
          title: input.source.title,
          published_at: input.source.publishedAt ?? null,
          observed_at: input.source.observedAt ?? new Date().toISOString(),
          fetched_at: input.source.fetchedAt ?? null,
          content_hash: input.source.contentSha256 ?? null,
          extracted_text: input.source.text,
          metadata: {
            image_search_title: input.searchResult.title,
            image_search_domain: input.searchResult.domain,
            image_search_url: input.searchResult.imageUrl,
          },
        },
      },
    });
    if (error) throw new Error(`Failed to register visual reference source: ${error.message}`);
    const row = requireRpcObject(data, "research_register_visual_source");
    if (typeof row.source_id !== "string" || !row.source_id) {
      throw new Error("Invalid visual reference source persistence response");
    }
    return row.source_id;
  }

  async listFingerprints(researchRunId: string): Promise<ExternalVisualFingerprint[]> {
    const { data, error } = await this.client.rpc("research_list_visual_fingerprints", {
      p_research_run_id: researchRunId,
    });
    if (error) throw new Error(`Failed to load visual reference fingerprints: ${error.message}`);
    const row = requireRpcObject(data, "research_list_visual_fingerprints");
    return array(row.items).flatMap((item) => {
      const value = object(item);
      if (
        typeof value.reference_id !== "string" ||
        typeof value.content_sha256 !== "string"
      ) {
        return [];
      }
      return [
        {
          referenceId: value.reference_id,
          contentSha256: value.content_sha256,
          ...(typeof value.perceptual_hash === "string" && value.perceptual_hash
            ? { perceptualHash: value.perceptual_hash }
            : {}),
        },
      ];
    });
  }

  async persistReference(input: {
    reference: ExternalVisualReferenceSpecV1;
    archive: ExternalVisualArchiveResult;
    searchMetadata?: Record<string, unknown>;
  }): Promise<{ duplicate: boolean; reference: ExternalVisualReferenceSpecV1 }> {
    const reference = externalVisualReferenceSpecV1Schema.parse(input.reference);
    const { data, error } = await this.client.rpc("research_persist_external_visual_reference", {
      payload: {
        reference,
        archive: input.archive,
        search_metadata: input.searchMetadata ?? {},
      },
    });
    if (error) throw new Error(`Failed to persist external visual reference: ${error.message}`);
    const row = requireRpcObject(data, "research_persist_external_visual_reference");
    if (row.persisted !== true) throw new Error("External visual reference was not persisted");
    return {
      duplicate: row.duplicate === true,
      reference: externalVisualReferenceSpecV1Schema.parse(row.reference ?? reference),
    };
  }

  async persistReferenceSet(input: {
    referenceSet: ReturnType<typeof imageReferenceSetSpecV1Schema.parse>;
    providerModel: string;
    providerLimit: number;
    lineage: CompiledImageReferenceLineage;
    referenceAssets: CompiledImageReferenceAsset[];
  }): Promise<void> {
    const referenceSet = imageReferenceSetSpecV1Schema.parse(input.referenceSet);
    const setHash = sha256({
      referenceSet,
      providerModel: input.providerModel,
      providerLimit: input.providerLimit,
      lineage: input.lineage,
      referenceAssets: input.referenceAssets.map((asset) => ({
        id: asset.id,
        origin: asset.origin,
        role: asset.role,
        mimeType: asset.mimeType,
      })),
    });
    const { data, error } = await this.client.rpc("research_persist_image_reference_set", {
      payload: {
        reference_set: referenceSet,
        provider_model: input.providerModel,
        provider_limit: input.providerLimit,
        set_hash: setHash,
        compiled_lineage: input.lineage,
        reference_assets: input.referenceAssets,
      },
    });
    if (error) throw new Error(`Failed to persist image reference set: ${error.message}`);
    const row = requireRpcObject(data, "research_persist_image_reference_set");
    if (row.persisted !== true || typeof row.reference_set_id !== "string") {
      throw new Error("Image reference set persistence returned an invalid response");
    }
  }
}
