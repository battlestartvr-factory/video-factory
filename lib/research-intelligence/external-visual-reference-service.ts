import "server-only";

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { OrchestratorRpcClient } from "@/lib/orchestrator/rpc";
import { createWebFetchProvider } from "@/lib/web/fetch-provider";
import { createKieGeminiGroundedSearchProvider } from "@/lib/web/kie-grounded-search";
import { createResearchToolbox } from "./toolbox";
import { RpcExternalVisualReferenceRepository } from "./visual-reference-runtime";
import {
  archiveExternalVisualReference,
  materializeExternalVisualReferences,
} from "./visual-reference-drive";
import {
  compileImageReferenceSetForProvider,
  curateExternalImageReferenceSet,
  discoverExternalVisualReferences,
  providerImageReferenceLimit,
  type CompiledImageReferenceInput,
  type ExternalVisualArchive,
} from "./visual-references";
import { imageReferenceSetSpecV1Schema } from "./schemas";

function rpcClient(): OrchestratorRpcClient {
  const service = createSupabaseServiceClient();
  return {
    async rpc(functionName, args) {
      const { data, error } = await service.rpc(functionName, args ?? {});
      return {
        data,
        error: error
          ? { message: error.message, code: error.code, details: error.details, hint: error.hint }
          : null,
      };
    },
  };
}

const directArchive: ExternalVisualArchive = {
  async archive(input) {
    return archiveExternalVisualReference({
      researchRunId: input.researchRunId,
      referenceId: input.referenceId,
      imageUrl: input.image.canonicalUrl,
      expectedSha256: input.image.contentSha256,
      expectedMimeType: input.image.mimeType,
      expectedWidth: input.image.width,
      expectedHeight: input.image.height,
    });
  },
};

async function existingReferenceSet(input: {
  researchRunId: string;
  conceptId: string;
  providerModel: string;
}): Promise<CompiledImageReferenceInput | null> {
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("research_image_reference_sets")
    .select("reference_set")
    .eq("run_id", input.researchRunId)
    .eq("concept_id", input.conceptId)
    .eq("provider_model", input.providerModel)
    .is("moment_id", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`EXTERNAL_REFERENCE_SET_LOOKUP_FAILED:${error.message}`);
  if (!data?.reference_set) return null;
  const set = imageReferenceSetSpecV1Schema.parse(data.reference_set);
  const assets = await materializeExternalVisualReferences({
    researchRunId: input.researchRunId,
    referenceIds: set.references.map((reference) => reference.referenceId),
  });
  return compileImageReferenceSetForProvider({
    providerModel: input.providerModel,
    referenceSet: set,
    assets,
  });
}

export async function resolveExternalVisualReferenceInput(input: {
  researchRunId: string;
  conceptId: string;
  providerModel: string;
  existingReferenceCount: number;
  query: string;
  mustNotCopy?: string[];
  signal?: AbortSignal;
}): Promise<CompiledImageReferenceInput | null> {
  const providerLimit = providerImageReferenceLimit(input.providerModel);
  const freeSlots = Math.max(0, providerLimit - Math.max(0, input.existingReferenceCount));
  if (freeSlots < 1) return null;

  const existing = await existingReferenceSet({
    researchRunId: input.researchRunId,
    conceptId: input.conceptId,
    providerModel: input.providerModel,
  });
  if (existing) {
    if (existing.referenceAssets.length <= freeSlots) return existing;
    return null;
  }

  const fetchProvider = createWebFetchProvider();
  const searchProvider = createKieGeminiGroundedSearchProvider(fetchProvider);
  const toolbox = createResearchToolbox({ searchProvider, fetchProvider });
  const repository = new RpcExternalVisualReferenceRepository(rpcClient());
  const query = input.query.trim().replace(/\s+/g, " ").slice(0, 2_000);
  if (!query) return null;

  const discovered = await discoverExternalVisualReferences({
    toolbox,
    repository,
    archive: directArchive,
    request: {
      researchRunId: input.researchRunId,
      query,
      roles: ["gameplay_grammar", "environment_object", "composition"],
      whyRelevant: "Source-grounded gameplay/visual reference for mechanic readability and scene grammar. Use only the labeled structural purpose, never source identity.",
      mustNotCopy: input.mustNotCopy ?? [
        "characters or brand identity",
        "exact level layout",
        "proprietary UI",
        "exact composition or visual design",
      ],
      trust: "normal",
      freshness: "mixed",
      maxCandidates: Math.min(8, Math.max(4, freeSlots * 2)),
      maxSelected: Math.min(4, freeSlots),
      signal: input.signal,
    },
  });
  if (!discovered.selected.length) return null;

  const referenceSet = curateExternalImageReferenceSet({
    conceptId: input.conceptId,
    researchRunId: input.researchRunId,
    externalReferences: discovered.selected,
    maxReferences: freeSlots,
    targetReferences: Math.min(freeSlots, discovered.selected.length),
    selectionRationale: "Stage 4.5 KIE-only source-page visual references supplement the curated Gameplay Reference Library without entering it.",
  });
  const assets = await materializeExternalVisualReferences({
    researchRunId: input.researchRunId,
    referenceIds: referenceSet.references.map((reference) => reference.referenceId),
  });
  const compiled = compileImageReferenceSetForProvider({
    providerModel: input.providerModel,
    referenceSet,
    assets,
  });
  await repository.persistReferenceSet?.({
    referenceSet,
    providerModel: input.providerModel,
    providerLimit,
    lineage: compiled.lineage,
    referenceAssets: compiled.referenceAssets,
  });
  return compiled;
}
