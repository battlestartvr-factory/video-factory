import { createHash } from "node:crypto";
import { z } from "zod";
import {
  researchEvidenceTypeSchema,
  researchScoutRoleSchema,
  type ResearchEvidenceSpecV1,
  type ResearchScoutRoleV1,
} from "./schemas";

const identifier = z.string().trim().min(1).max(200);
const shortText = z.string().trim().min(1).max(500);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const metadata = z.record(z.string(), z.unknown()).default({});

export const researchSourceCandidateV1Schema = z
  .object({
    sourceRef: identifier,
    canonicalUrl: z.string().url().max(4_000),
    urlSha256: sha256,
    sourceType: z.string().trim().min(1).max(100).default("web_page"),
    title: z.string().trim().max(1_000).optional(),
    publishedAt: z.string().datetime({ offset: true }).optional(),
    observedAt: z.string().datetime({ offset: true }),
    fetchedAt: z.string().datetime({ offset: true }).optional(),
    contentSha256: sha256.optional(),
    extractedText: z.string().max(30_000).optional(),
    relevanceScore: z.number().min(0).max(1).optional(),
    reusedFromCache: z.boolean().default(false),
    metadata,
  })
  .strict();

export const researchEvidenceDraftV1Schema = z
  .object({
    evidenceRef: identifier,
    evidenceType: researchEvidenceTypeSchema,
    subject: shortText,
    claim: z.string().trim().min(1).max(4_000),
    sourceRefs: z.array(identifier).min(1).max(30),
    confidence: z.number().min(0).max(1),
    freshnessClass: z.enum(["fresh", "recent", "evergreen", "unknown"]),
    observedAt: z.string().datetime({ offset: true }),
    tags: z.array(shortText).max(50).default([]),
    metadata,
  })
  .strict();

export const researchScoutEvidenceBundleV1Schema = z
  .object({
    schema: z.literal("research_scout_evidence_bundle"),
    version: z.literal(1),
    researchRunId: identifier,
    scoutRole: researchScoutRoleSchema,
    sources: z.array(researchSourceCandidateV1Schema).max(6),
    evidence: z.array(researchEvidenceDraftV1Schema).max(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    const sourceRefs = new Set<string>();
    for (const [index, source] of value.sources.entries()) {
      if (sourceRefs.has(source.sourceRef)) {
        ctx.addIssue({
          code: "custom",
          path: ["sources", index, "sourceRef"],
          message: "sourceRef must be unique inside one Scout bundle",
        });
      }
      sourceRefs.add(source.sourceRef);
      try {
        const protocol = new URL(source.canonicalUrl).protocol;
        if (protocol !== "http:" && protocol !== "https:") {
          ctx.addIssue({
            code: "custom",
            path: ["sources", index, "canonicalUrl"],
            message: "Research sources must use http/https",
          });
        }
      } catch {
        // z.string().url() already reports malformed URLs.
      }
    }

    const evidenceRefs = new Set<string>();
    for (const [index, item] of value.evidence.entries()) {
      if (evidenceRefs.has(item.evidenceRef)) {
        ctx.addIssue({
          code: "custom",
          path: ["evidence", index, "evidenceRef"],
          message: "evidenceRef must be unique inside one Scout bundle",
        });
      }
      evidenceRefs.add(item.evidenceRef);
      for (const [sourceIndex, sourceRef] of item.sourceRefs.entries()) {
        if (!sourceRefs.has(sourceRef)) {
          ctx.addIssue({
            code: "custom",
            path: ["evidence", index, "sourceRefs", sourceIndex],
            message: `Unknown sourceRef: ${sourceRef}`,
          });
        }
      }
    }
  });

export type ResearchSourceCandidateV1 = z.infer<typeof researchSourceCandidateV1Schema>;
export type ResearchEvidenceDraftV1 = z.infer<typeof researchEvidenceDraftV1Schema>;
export type ResearchScoutEvidenceBundleV1 = z.infer<typeof researchScoutEvidenceBundleV1Schema>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .map((key) => [key, stableValue(input[key])]),
    );
  }
  return value;
}

export function stableResearchJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function researchSha256(value: unknown): string {
  return createHash("sha256").update(stableResearchJson(value)).digest("hex");
}

function normalizedClaimPart(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

export function evidenceFingerprint(input: {
  scoutRole: ResearchScoutRoleV1;
  evidence: ResearchEvidenceDraftV1;
  sourceUrlHashes: string[];
}): string {
  return researchSha256({
    scoutRole: input.scoutRole,
    evidenceType: input.evidence.evidenceType,
    subject: normalizedClaimPart(input.evidence.subject),
    claim: normalizedClaimPart(input.evidence.claim),
    sourceUrlHashes: [...new Set(input.sourceUrlHashes.map((item) => item.toLowerCase()))].sort(),
  });
}

export interface PersistedScoutEvidenceBundleV1 {
  duplicate: boolean;
  bundleHash: string;
  sourceIdsByRef: Record<string, string>;
  evidenceIdsByRef: Record<string, string>;
  evidence: ResearchEvidenceSpecV1[];
}

export function bundleForRpc(bundle: ResearchScoutEvidenceBundleV1): Record<string, unknown> {
  const parsed = researchScoutEvidenceBundleV1Schema.parse(bundle);
  const sourceHashes = new Map(parsed.sources.map((source) => [source.sourceRef, source.urlSha256]));

  return {
    schema: parsed.schema,
    version: parsed.version,
    research_run_id: parsed.researchRunId,
    scout_role: parsed.scoutRole,
    sources: parsed.sources.map((source) => ({
      source_ref: source.sourceRef,
      canonical_url: source.canonicalUrl,
      url_hash: source.urlSha256.toLowerCase(),
      source_type: source.sourceType,
      title: source.title ?? null,
      published_at: source.publishedAt ?? null,
      observed_at: source.observedAt,
      fetched_at: source.fetchedAt ?? null,
      content_hash: source.contentSha256?.toLowerCase() ?? null,
      extracted_text: source.extractedText ?? null,
      relevance_score: source.relevanceScore ?? null,
      reused_from_cache: source.reusedFromCache,
      metadata: source.metadata,
    })),
    evidence: parsed.evidence.map((item) => ({
      evidence_ref: item.evidenceRef,
      evidence_fingerprint: evidenceFingerprint({
        scoutRole: parsed.scoutRole,
        evidence: item,
        sourceUrlHashes: item.sourceRefs.map((sourceRef) => sourceHashes.get(sourceRef)!),
      }),
      evidence_type: item.evidenceType,
      subject: item.subject,
      claim: item.claim,
      source_refs: item.sourceRefs,
      confidence: item.confidence,
      freshness_class: item.freshnessClass,
      observed_at: item.observedAt,
      tags: item.tags,
      metadata: item.metadata,
    })),
  };
}
