import { DurableWorkflowError } from "../orchestrator/retry";
import { urlSha256 } from "../web";
import type { SearchResult } from "../web";
import {
  researchScoutEvidenceBundleV1Schema,
  type ResearchEvidenceDraftV1,
  type ResearchScoutEvidenceBundleV1,
  type ResearchSourceCandidateV1,
} from "./evidence-bundle";
import type {
  ResearchScoutExecutionResult,
  ResearchScoutExecutor,
  ResearchScoutJobContext,
} from "./scout-runtime";
import {
  researchScoutReportSpecV1Schema,
  type ResearchEvidenceTypeV1,
  type ResearchScoutRoleV1,
} from "./schemas";
import type { ResearchToolbox } from "./toolbox";

function metadataArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function evidenceType(role: ResearchScoutRoleV1, index: number): ResearchEvidenceTypeV1 {
  switch (role) {
    case "market_competitor":
      return index % 3 === 2 ? "saturation_signal" : "market_pattern";
    case "mechanics":
      return "mechanic_pattern";
    case "player_voice":
      return index % 2 === 0 ? "player_love" : "player_pain";
    case "gameplay_visual":
      return index % 2 === 0 ? "gameplay_reference_pattern" : "visual_reference_pattern";
    case "white_space_contrarian":
      return index % 2 === 0 ? "white_space" : "counterexample";
  }
}

function freshnessClass(value: ResearchScoutJobContext["assignment"]["freshness"]): ResearchEvidenceDraftV1["freshnessClass"] {
  if (value === "current") return "fresh";
  if (value === "recent") return "recent";
  if (value === "evergreen") return "evergreen";
  return "unknown";
}

function combinedQuery(context: ResearchScoutJobContext): string {
  const assignment = context.assignment;
  return [
    assignment.mandate,
    ...assignment.queryAngles.map((angle) => `Research angle: ${angle}`),
    assignment.sourcePreferences.length
      ? `Prefer source types/domains where useful: ${assignment.sourcePreferences.join(", ")}.`
      : "",
    assignment.forbiddenOverlap.length
      ? `Avoid duplicating these research areas: ${assignment.forbiddenOverlap.join(", ")}.`
      : "",
    assignment.imageSearchRequired
      ? "Also prioritize source pages that contain real gameplay screenshots or visual gameplay evidence."
      : "",
  ].filter(Boolean).join("\n");
}

function groundedClaims(result: SearchResult): string[] {
  const claims = metadataArray(result.providerMetadata?.groundedClaims);
  if (claims.length > 0) return claims;
  return result.snippet?.trim() ? [result.snippet.trim()] : [];
}

function providerUsage(results: SearchResult[]): Record<string, unknown> {
  const first = results[0]?.providerMetadata;
  const usage = first?.usage;
  return usage && typeof usage === "object" && !Array.isArray(usage)
    ? (usage as Record<string, unknown>)
    : {};
}

export class KieGroundedResearchScoutExecutor implements ResearchScoutExecutor {
  constructor(
    private readonly toolbox: ResearchToolbox,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: {
    jobId: string;
    context: ResearchScoutJobContext;
    signal: AbortSignal;
  }): Promise<ResearchScoutExecutionResult> {
    const { context } = input;
    const budget = context.assignment.budget;
    const generatedAt = this.now().toISOString();

    if (budget.maxSearchQueries < 1 || budget.maxFetchedSources < 1) {
      const emptyBundle: ResearchScoutEvidenceBundleV1 = researchScoutEvidenceBundleV1Schema.parse({
        schema: "research_scout_evidence_bundle",
        version: 1,
        researchRunId: context.researchRunId,
        scoutRole: context.scoutRole,
        sources: [],
        evidence: [],
      });
      return {
        report: researchScoutReportSpecV1Schema.parse({
          schema: "research_scout_report",
          version: 1,
          researchRunId: context.researchRunId,
          scoutRole: context.scoutRole,
          summary: "This Scout had no durable web-search/source budget.",
          sourceIds: [],
          evidenceIds: [],
          imageCandidateIds: [],
          queriesExecuted: 0,
          coverageNotes: ["No web-search budget was available for this assignment."],
          warnings: [],
          generatedAt,
        }),
        evidenceBundle: emptyBundle,
        usage: {},
        provider: "kie",
        model: "gemini-3-6-flash",
      };
    }

    if (input.signal.aborted) throw input.signal.reason ?? new Error("Research Scout aborted");

    const search = await this.toolbox.searchText({
      query: combinedQuery(context),
      maxResults: budget.maxFetchedSources,
      freshness: context.assignment.freshness,
    });
    const searchResults = search.value.slice(0, budget.maxFetchedSources);
    if (searchResults.length === 0) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SCOUT_NO_GROUNDED_SOURCES",
        message: "KIE Google Search returned no grounded source URLs for the Scout assignment",
        retryable: false,
        details: { scout_role: context.scoutRole },
      });
    }

    const sources: ResearchSourceCandidateV1[] = [];
    const resultBySourceRef = new Map<string, SearchResult>();
    const warnings: string[] = [];
    let discoveredPageImageCandidates = 0;

    for (const result of searchResults) {
      if (input.signal.aborted) throw input.signal.reason ?? new Error("Research Scout aborted");
      if (sources.length >= budget.maxFetchedSources) break;
      try {
        const fetched = await this.toolbox.fetchSource({
          url: result.canonicalUrl ?? result.url,
          query: context.assignment.mandate,
          freshness: context.assignment.freshness,
          excerptMaxChars: 8_000,
        });
        const document = fetched.document;
        const canonicalUrl = document.canonicalUrl ?? document.url;
        const sourceRef = `source-${sources.length + 1}`;
        discoveredPageImageCandidates += document.imageCandidates?.length ?? 0;
        sources.push({
          sourceRef,
          canonicalUrl,
          urlSha256: document.urlSha256 ?? urlSha256(canonicalUrl),
          sourceType: "web_page",
          title: document.title || result.title,
          ...(document.publishedAt ? { publishedAt: document.publishedAt } : {}),
          observedAt: document.observedAt ?? generatedAt,
          ...(document.fetchedAt ? { fetchedAt: document.fetchedAt } : {}),
          ...(document.contentSha256 ? { contentSha256: document.contentSha256 } : {}),
          extractedText: document.text.slice(0, 30_000),
          relevanceScore: Math.max(0.55, 0.95 - sources.length * 0.05),
          reusedFromCache: fetched.reusedFromCache,
          metadata: {
            domain: document.domain,
            kie_grounded: true,
            provider_metadata: result.providerMetadata ?? {},
            page_image_candidate_count: document.imageCandidates?.length ?? 0,
          },
        });
        resultBySourceRef.set(sourceRef, result);
      } catch (error) {
        warnings.push(`Source fetch skipped: ${error instanceof Error ? error.message : String(error)}`.slice(0, 240));
      }
    }

    if (sources.length === 0) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SCOUT_NO_SAFE_FETCHED_SOURCES",
        message: "Grounded search sources were returned, but none passed the safe-fetch boundary",
        retryable: false,
        details: { scout_role: context.scoutRole },
      });
    }

    const evidence: ResearchEvidenceDraftV1[] = [];
    const seenClaims = new Set<string>();
    for (const source of sources) {
      const result = resultBySourceRef.get(source.sourceRef);
      if (!result) continue;
      for (const claim of groundedClaims(result)) {
        const normalized = claim.toLowerCase().replace(/\s+/g, " ").trim();
        if (!normalized || seenClaims.has(normalized)) continue;
        seenClaims.add(normalized);
        const index = evidence.length;
        evidence.push({
          evidenceRef: `evidence-${index + 1}`,
          evidenceType: evidenceType(context.scoutRole, index),
          subject: source.title?.slice(0, 500) || result.title.slice(0, 500),
          claim: claim.slice(0, 4_000),
          sourceRefs: [source.sourceRef],
          confidence: 0.82,
          freshnessClass: freshnessClass(context.assignment.freshness),
          observedAt: source.observedAt,
          tags: [context.scoutRole, "kie_google_search", "grounded"],
          metadata: {
            grounding_chunk_index: result.providerMetadata?.groundingChunkIndex ?? null,
          },
        });
        if (evidence.length >= budget.maxEvidenceItems) break;
      }
      if (evidence.length >= budget.maxEvidenceItems) break;
    }

    if (evidence.length === 0) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SCOUT_GROUNDED_CLAIMS_MISSING",
        message: "KIE returned grounded sources but no grounded claim text usable as evidence",
        retryable: false,
        details: { scout_role: context.scoutRole },
      });
    }

    const evidenceBundle = researchScoutEvidenceBundleV1Schema.parse({
      schema: "research_scout_evidence_bundle",
      version: 1,
      researchRunId: context.researchRunId,
      scoutRole: context.scoutRole,
      sources,
      evidence,
    });
    const summary = evidence.slice(0, 4).map((item) => item.claim).join(" ").slice(0, 4_000);
    const firstMetadata = searchResults[0]?.providerMetadata ?? {};
    const model = typeof firstMetadata.model === "string" ? firstMetadata.model : "gemini-3-6-flash";

    return {
      report: researchScoutReportSpecV1Schema.parse({
        schema: "research_scout_report",
        version: 1,
        researchRunId: context.researchRunId,
        scoutRole: context.scoutRole,
        summary,
        sourceIds: sources.map((source) => source.sourceRef),
        evidenceIds: evidence.map((item) => item.evidenceRef),
        imageCandidateIds: [],
        queriesExecuted: 1,
        coverageNotes: [
          `${sources.length} safely fetched Google-grounded source pages.`,
          `${evidence.length} grounded evidence claims extracted.`,
          context.assignment.imageSearchRequired
            ? `${discoveredPageImageCandidates} page image candidates discovered without a second paid search provider.`
            : "Visual-source harvesting was not required for this Scout role.",
        ],
        warnings: warnings.slice(0, 20),
        generatedAt,
      }),
      evidenceBundle,
      usage: {
        ...providerUsage(searchResults),
        search_provider: "kie_gemini_google_search",
        search_calls: 1,
        safely_fetched_sources: sources.length,
        page_image_candidates: discoveredPageImageCandidates,
      },
      model,
      provider: "kie",
    };
  }
}
