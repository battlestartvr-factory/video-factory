import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DurableImageGeneration } from "@/lib/orchestrator/generation-images";
import type { ResearchToolbox } from "@/lib/research-intelligence/toolbox";
import {
  applyCompiledReferencesToGeneration,
  compileImageReferenceSetForProvider,
  curateExternalImageReferenceSet,
  discoverExternalVisualReferences,
  findVisualDuplicate,
  hammingDistanceHex,
  type ExternalVisualReferenceRepository,
} from "@/lib/research-intelligence/visual-references";
import { externalVisualReferenceSpecV1Schema } from "@/lib/research-intelligence/schemas";
import { buildImageProviderRequest } from "@/worker/workflows/generation-image-v1";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260820135000_stage4_5_web_visual_references.sql"),
  "utf8",
);

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-08-20T12:00:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function cached<T>(value: T) {
  return {
    value,
    reusedFromCache: false,
    cacheKey: "cache-key",
    storedAt: NOW,
    expiresAt: "2026-08-21T12:00:00.000Z",
  };
}

function toolbox(input?: { sha?: string; perceptualHash?: string }): ResearchToolbox {
  const sha = input?.sha ?? SHA_A;
  return {
    searchText: vi.fn(),
    searchImages: vi.fn().mockResolvedValue(
      cached([
        {
          title: "Readable co-op gameplay frame",
          imageUrl: "https://images.example.com/frame.png",
          sourceUrl: "https://example.com/gameplay",
          domain: "example.com",
          width: 1280,
          height: 720,
          mimeType: "image/png",
          observedAt: NOW,
          providerMetadata: input?.perceptualHash
            ? { perceptualHash: input.perceptualHash }
            : {},
        },
      ]),
    ),
    fetchSource: vi.fn().mockResolvedValue({
      document: {
        url: "https://example.com/gameplay",
        canonicalUrl: "https://example.com/gameplay",
        title: "Gameplay source",
        domain: "example.com",
        text: "A bounded source page describing the screenshot.",
        observedAt: NOW,
        fetchedAt: NOW,
        contentSha256: "c".repeat(64),
        urlSha256: "d".repeat(64),
      },
      evidence: {
        source: "external_web",
        trustBoundary: "untrusted",
        query: "co-op machinery gameplay",
        excerpt: "bounded evidence",
      },
      reusedFromCache: false,
      cacheKey: "source-cache",
    }),
    fetchImage: vi.fn().mockResolvedValue({
      image: {
        url: "https://images.example.com/frame.png",
        canonicalUrl: "https://images.example.com/frame.png",
        domain: "images.example.com",
        mimeType: "image/png",
        width: 1280,
        height: 720,
        byteLength: 128,
        contentSha256: sha,
        urlSha256: "e".repeat(64),
        observedAt: NOW,
        fetchedAt: NOW,
        bytes: new Uint8Array([1, 2, 3]),
      },
      reusedFromCache: false,
      cacheKey: "image-cache",
      duplicateContentCacheKey: `research:image-content:v1:${sha}`,
    }),
  } as ResearchToolbox;
}

function memoryRepository(existing: Array<{ referenceId: string; contentSha256: string; perceptualHash?: string }> = []) {
  const persisted: ReturnType<typeof externalVisualReferenceSpecV1Schema.parse>[] = [];
  const repository: ExternalVisualReferenceRepository = {
    registerSource: vi.fn().mockResolvedValue(SOURCE_ID),
    listFingerprints: vi.fn().mockResolvedValue(existing),
    persistReference: vi.fn().mockImplementation(async ({ reference }) => {
      const parsed = externalVisualReferenceSpecV1Schema.parse(reference);
      persisted.push(parsed);
      return { duplicate: false, reference: parsed };
    }),
    persistReferenceSet: vi.fn().mockResolvedValue(undefined),
  };
  return { repository, persisted };
}

function reference(input: {
  id: string;
  role: "gameplay_grammar" | "environment_object" | "composition" | "art_direction";
  trust?: "preferred" | "normal" | "low";
}) {
  return externalVisualReferenceSpecV1Schema.parse({
    schema: "external_visual_reference",
    version: 1,
    referenceId: input.id,
    researchRunId: RUN_ID,
    sourceId: SOURCE_ID,
    sourceUrl: "https://example.com/source",
    imageUrl: `https://images.example.com/${input.id}.png`,
    observedAt: NOW,
    driveFileId: `drive-${input.id}`,
    mimeType: "image/png",
    width: 1280,
    height: 720,
    contentSha256: input.id.slice(0, 1).padEnd(64, "f").replace(/[^a-f0-9]/g, "a"),
    roles: [input.role],
    whyRelevant: `Use ${input.role} only for its labeled visual purpose.`,
    mustNotCopy: ["characters", "branding", "level layout"],
    trust: input.trust ?? "normal",
    metadata: { external_reference: true, generated_asset: false, gameplay_library_entry: false },
  });
}

describe("Stage 4.5 PR6 web visual discovery", () => {
  it("turns a validated web image into an archived ExternalVisualReference with provenance", async () => {
    const { repository, persisted } = memoryRepository();
    const archive = {
      archive: vi.fn().mockResolvedValue({
        driveFileId: "drive-external-1",
        driveWebUrl: "https://drive.google.com/file/d/drive-external-1/view",
        filename: "external-visual.png",
        mimeType: "image/png",
        sizeBytes: 128,
        archivedAt: NOW,
      }),
    };

    const result = await discoverExternalVisualReferences({
      toolbox: toolbox({ perceptualHash: "0123456789abcdef" }),
      repository,
      archive,
      request: {
        researchRunId: RUN_ID,
        query: "co-op machinery gameplay",
        roles: ["gameplay_grammar"],
        whyRelevant: "Camera and interaction distance make the mechanically necessary co-op action readable.",
        mustNotCopy: ["characters", "branding", "exact composition"],
        maxCandidates: 4,
        maxSelected: 2,
      },
    });

    expect(result.selected).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.selected[0]).toMatchObject({
      researchRunId: RUN_ID,
      sourceId: SOURCE_ID,
      driveFileId: "drive-external-1",
      contentSha256: SHA_A,
      roles: ["gameplay_grammar"],
    });
    expect(result.selected[0]!.metadata).toMatchObject({
      external_reference: true,
      generated_asset: false,
      gameplay_library_entry: false,
    });
    expect(persisted).toHaveLength(1);
    expect(archive.archive).toHaveBeenCalledTimes(1);
  });

  it("rejects exact and perceptual near-duplicates before Drive archive", () => {
    expect(
      findVisualDuplicate({
        contentSha256: SHA_A,
        existing: [{ referenceId: "exact", contentSha256: SHA_A }],
      }),
    ).toEqual({ kind: "exact", referenceId: "exact" });

    expect(hammingDistanceHex("0000000000000000", "0000000000000003")).toBe(2);
    expect(
      findVisualDuplicate({
        contentSha256: SHA_B,
        perceptualHash: "0000000000000003",
        existing: [
          {
            referenceId: "near",
            contentSha256: SHA_A,
            perceptualHash: "0000000000000000",
          },
        ],
      }),
    ).toEqual({ kind: "perceptual", referenceId: "near" });
  });

  it("rejects an image-search result with no source-page provenance", async () => {
    const noSource = toolbox();
    vi.mocked(noSource.searchImages).mockResolvedValue(
      cached([
        {
          title: "orphan image",
          imageUrl: "https://images.example.com/orphan.png",
          domain: "images.example.com",
        },
      ]),
    );
    const { repository } = memoryRepository();
    const archive = { archive: vi.fn() };
    const result = await discoverExternalVisualReferences({
      toolbox: noSource,
      repository,
      archive,
      request: {
        researchRunId: RUN_ID,
        query: "orphan",
        roles: ["composition"],
        whyRelevant: "Composition candidate",
      },
    });
    expect(result.selected).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("missing_source_provenance");
    expect(archive.archive).not.toHaveBeenCalled();
  });
});

describe("Stage 4.5 PR6 ImageReferenceSet and provider compiler", () => {
  it("selects a bounded role-prioritized set instead of sending every web image", () => {
    const refs = [
      reference({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", role: "art_direction", trust: "preferred" }),
      reference({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", role: "composition" }),
      reference({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", role: "environment_object" }),
      reference({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", role: "gameplay_grammar" }),
      reference({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5", role: "art_direction" }),
    ];
    const set = curateExternalImageReferenceSet({
      conceptId: "concept-1",
      researchRunId: RUN_ID,
      externalReferences: refs,
      maxReferences: 4,
      targetReferences: 3,
    });
    expect(set.references).toHaveLength(3);
    expect(set.references[0]).toMatchObject({ role: "gameplay_grammar", origin: "external_research" });
    expect(set.references.map((item) => item.role)).toEqual([
      "gameplay_grammar",
      "environment_object",
      "composition",
    ]);
  });

  it("puts the selected archived web image into the real generation provider request and preserves exact IDs", () => {
    const external = reference({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
      role: "gameplay_grammar",
    });
    const set = curateExternalImageReferenceSet({
      conceptId: "concept-1",
      researchRunId: RUN_ID,
      externalReferences: [external],
      maxReferences: 4,
      targetReferences: 1,
    });
    const signedUrl = "https://project.supabase.co/storage/v1/object/sign/generator-inputs/external.png?token=test";
    const compiled = compileImageReferenceSetForProvider({
      providerModel: "gpt-image-2",
      referenceSet: set,
      assets: [
        {
          id: external.referenceId,
          url: signedUrl,
          mimeType: "image/png",
          filename: "external.png",
          role: "gameplay_grammar",
          origin: "external_research",
        },
      ],
    });

    const generation: DurableImageGeneration = {
      id: "generation-1",
      prompt: "Generate a readable co-op gameplay still.",
      modelId: "gpt-image-2",
      mode: "quality",
      settings: { aspectRatio: "16:9" },
      referenceAssets: [],
      status: "queued",
    };
    const withReferences = applyCompiledReferencesToGeneration({ generation, compiled });
    const providerRequest = buildImageProviderRequest(withReferences);

    expect(providerRequest.model).toBe("gpt-image-2-image-to-image");
    expect(providerRequest.input).toMatchObject({ input_urls: [signedUrl] });
    expect(compiled.lineage.selectedReferenceIds).toEqual([external.referenceId]);
    expect(withReferences.settings.imageReferenceLineage).toMatchObject({
      selectedReferenceIds: [external.referenceId],
      researchRunId: RUN_ID,
    });
    expect(withReferences.prompt).toContain("Must not copy");
  });

  it("fails closed when an ImageReferenceSet exceeds the provider reference limit", () => {
    const refs = Array.from({ length: 5 }, (_, index) =>
      reference({
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`,
        role: index === 0 ? "gameplay_grammar" : "art_direction",
      }),
    );
    const set = curateExternalImageReferenceSet({
      conceptId: "concept-1",
      researchRunId: RUN_ID,
      externalReferences: refs,
      maxReferences: 8,
      targetReferences: 5,
    });
    expect(() =>
      compileImageReferenceSetForProvider({
        providerModel: "nano-banana-pro",
        referenceSet: set,
        assets: set.references.map((item) => ({
          id: item.referenceId,
          url: `https://example.com/${item.referenceId}.png`,
          mimeType: "image/png",
          filename: `${item.referenceId}.png`,
          role: item.role,
          origin: item.origin,
        })),
      }),
    ).toThrow(/IMAGE_REFERENCE_SET_PROVIDER_LIMIT:5:4/);
  });
});

describe("Stage 4.5 PR6 durable classification contract", () => {
  it("persists external refs and compiled lineage without polluting generated assets or gameplay library", () => {
    expect(migration).toContain("research_image_reference_sets");
    expect(migration).toContain("external_visual_reference_archive_required");
    expect(migration).toContain("external_visual_reference_exact_duplicate");
    expect(migration).toContain("gameplay_library_entry', FALSE");
    expect(migration).toContain("generated_asset', FALSE");
    expect(migration).toContain("image_reference_set_external_lineage_invalid");
    expect(migration).not.toContain("INSERT INTO public.gameplay_references");
    expect(migration).not.toContain("INSERT INTO public.generations");
  });
});
