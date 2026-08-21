import {
  researchScoutEvidenceBundleV1Schema,
  type ResearchEvidenceDraftV1,
  type ResearchSourceCandidateV1,
} from "./evidence-bundle";
import { sanitizeGroundedEvidenceClaim } from "./kie-research-scout";
import type { ResearchScoutProgressReporter } from "./progress";
import type {
  ResearchScoutExecutionResult,
  ResearchScoutExecutor,
  ResearchScoutJobContext,
} from "./scout-runtime";
import { researchScoutReportSpecV1Schema, type ResearchScoutRoleV1 } from "./schemas";
import {
  sharedResearchSourcePoolV1Schema,
  type SharedResearchSourcePoolItemV1,
  type SharedResearchSourcePoolV1,
} from "./shared-source-pool";

const ROLE_TERMS: Record<ResearchScoutRoleV1, string[]> = {
  market_competitor: ["competitor", "market", "steam", "release", "sales", "genre", "similar", "players", "co-op", "coop"],
  mechanics: ["mechanic", "physics", "grapple", "movement", "ability", "interaction", "dependency", "cooperation", "team", "player"],
  player_voice: ["review", "reviews", "players", "community", "fun", "frustrat", "boring", "repet", "friends", "chaos", "fair", "unfair"],
  gameplay_visual: ["gameplay", "camera", "screen", "screenshot", "visual", "arena", "environment", "third-person", "first-person", "player"],
  white_space_contrarian: ["similar", "already", "existing", "unusual", "rare", "different", "novel", "unique", "counter", "comparison", "competitor"],
};

function evidenceType(role: ResearchScoutRoleV1, index: number): ResearchEvidenceDraftV1["evidenceType"] {
  switch (role) {
    case "market_competitor": return index % 3 === 2 ? "saturation_signal" : "market_pattern";
    case "mechanics": return "mechanic_pattern";
    case "player_voice": return index % 2 === 0 ? "player_love" : "player_pain";
    case "gameplay_visual": return index % 2 === 0 ? "gameplay_reference_pattern" : "visual_reference_pattern";
    case "white_space_contrarian": return index % 2 === 0 ? "white_space" : "counterexample";
  }
}

function freshnessClass(value: ResearchScoutJobContext["assignment"]["freshness"]): ResearchEvidenceDraftV1["freshnessClass"] {
  if (value === "current") return "fresh";
  if (value === "recent") return "recent";
  if (value === "evergreen") return "evergreen";
  return "unknown";
}

export function sanitizeSharedPoolEvidenceClaim(value: string): string | null {
  const base = sanitizeGroundedEvidenceClaim(value);
  if (!base) return null;
  // A real production failure persisted a fragment like `"). 2. https://...`.
  // Any residual URL/ledger syntax means the candidate is provenance plumbing,
  // not human-readable evidence, so reject it instead of trying to repair it.
  if (/https?:\/\/|www\.|(?:SOURCE|SOURCE_URL|CITATION)\s*[|:]/i.test(base)) return null;
  const letters = base.match(/\p{L}/gu)?.length ?? 0;
  const punctuation = base.match(/[\p{P}\p{S}]/gu)?.length ?? 0;
  if (letters < 12) return null;
  if (punctuation > Math.max(16, Math.floor(base.length * 0.3))) return null;
  return base;
}

function sentences(text: string): string[] {
  return text
    .replace(/\r/g, "\n")
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((value) => sanitizeSharedPoolEvidenceClaim(value))
    .filter((value): value is string => Boolean(value));
}

function roleScore(role: ResearchScoutRoleV1, value: string): number {
  const lower = value.toLowerCase();
  return ROLE_TERMS[role].reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
}

function itemText(item: SharedResearchSourcePoolItemV1): string {
  return [
    item.source.title ?? "",
    ...item.groundedClaims,
    item.source.extractedText?.slice(0, 12_000) ?? "",
  ].join(" ");
}

function selectSources(
  pool: SharedResearchSourcePoolV1,
  role: ResearchScoutRoleV1,
  maxSources: number,
): SharedResearchSourcePoolItemV1[] {
  return pool.sources
    .map((item, index) => ({ item, index, score: roleScore(role, itemText(item)) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(1, maxSources))
    .map(({ item }) => item);
}

function claimsForItem(item: SharedResearchSourcePoolItemV1, role: ResearchScoutRoleV1): string[] {
  const grounded = item.groundedClaims
    .map(sanitizeSharedPoolEvidenceClaim)
    .filter((value): value is string => Boolean(value));
  const extracted = sentences(item.source.extractedText ?? "").slice(0, 40);
  const combined = [...grounded, ...extracted];
  const unique = [...new Map(combined.map((claim) => [claim.toLowerCase(), claim])).values()];
  const relevant = unique.filter((claim) => roleScore(role, claim) > 0);
  // Prefer role-specific evidence, but a safely fetched source sentence is still
  // valid source-backed evidence when wording does not contain our small keyword set.
  return (relevant.length > 0 ? relevant : unique).slice(0, 8);
}

export class SharedSourcePoolResearchScoutExecutor implements ResearchScoutExecutor {
  private readonly pool: SharedResearchSourcePoolV1;

  constructor(
    pool: SharedResearchSourcePoolV1,
    private readonly reportProgress?: ResearchScoutProgressReporter,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.pool = sharedResearchSourcePoolV1Schema.parse(pool);
  }

  private async progress(
    eventType: Parameters<ResearchScoutProgressReporter>[0]["eventType"],
    key: string,
    payload: Record<string, unknown> = {},
  ) {
    await this.reportProgress?.({ eventType, key, payload });
  }

  async execute(input: {
    jobId: string;
    context: ResearchScoutJobContext;
    signal: AbortSignal;
  }): Promise<ResearchScoutExecutionResult> {
    if (input.signal.aborted) throw input.signal.reason ?? new Error("Research Scout aborted");
    const { context } = input;
    if (this.pool.researchRunId !== context.researchRunId) {
      throw new Error("Shared source pool research-run lineage mismatch");
    }
    const startedAt = Date.now();
    const generatedAt = this.now().toISOString();
    const budget = context.assignment.budget;
    const selected = selectSources(this.pool, context.scoutRole, budget.maxFetchedSources);

    await this.progress("research.scout.started", "scout_started", {
      mandate: context.assignment.mandate.slice(0, 500),
      shared_source_pool: true,
      shared_pool_source_count: this.pool.sources.length,
    });
    await this.progress("research.source_pool.reused", "shared_source_pool_reused", {
      pool_source_count: this.pool.sources.length,
      selected_source_count: selected.length,
      acquisition_owner: this.pool.acquisitionOwnerJobId === input.jobId,
    });

    const sources: ResearchSourceCandidateV1[] = selected.map((item) => item.source);
    const evidence: ResearchEvidenceDraftV1[] = [];
    const seen = new Set<string>();
    for (const item of selected) {
      for (const claim of claimsForItem(item, context.scoutRole)) {
        const key = claim.toLowerCase().replace(/\s+/g, " ").trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const index = evidence.length;
        evidence.push({
          evidenceRef: `evidence-${index + 1}`,
          evidenceType: evidenceType(context.scoutRole, index),
          subject: item.source.title?.slice(0, 500) || new URL(item.source.canonicalUrl).hostname,
          claim,
          sourceRefs: [item.source.sourceRef],
          confidence: item.groundedClaims.includes(claim) ? 0.84 : 0.74,
          freshnessClass: freshnessClass(context.assignment.freshness),
          observedAt: item.source.observedAt,
          tags: [context.scoutRole, "shared_verified_source_pool", "source_backed"],
          metadata: {
            shared_source_pool: true,
            direct_page_sentence: !item.groundedClaims.includes(claim),
          },
        });
        if (evidence.length >= budget.maxEvidenceItems) break;
      }
      if (evidence.length >= budget.maxEvidenceItems) break;
    }

    if (evidence.length === 0) {
      throw new Error(`Shared verified source pool contained no usable evidence for ${context.scoutRole}`);
    }

    await this.progress("research.evidence.extracted", "evidence_extracted", {
      evidence_count: evidence.length,
      shared_source_pool: true,
      items: evidence.slice(0, 12).map((item) => ({
        evidence_ref: item.evidenceRef,
        evidence_type: item.evidenceType,
        subject: item.subject.slice(0, 300),
        claim: item.claim.slice(0, 1_000),
        confidence: item.confidence,
      })),
    });

    const evidenceBundle = researchScoutEvidenceBundleV1Schema.parse({
      schema: "research_scout_evidence_bundle",
      version: 1,
      researchRunId: context.researchRunId,
      scoutRole: context.scoutRole,
      sources,
      evidence,
    });
    const summary = evidence.slice(0, 4).map((item) => item.claim).join(" ").slice(0, 4_000);
    const acquisitionOwner = this.pool.acquisitionOwnerJobId === input.jobId;
    const imageCandidates = context.assignment.imageSearchRequired
      ? sources.reduce((sum, source) => sum + Number(source.metadata.page_image_candidate_count ?? 0), 0)
      : 0;
    const totalMs = Math.max(0, Date.now() - startedAt);

    await this.progress("research.scout.execution_completed", "scout_execution_completed", {
      source_count: sources.length,
      evidence_count: evidence.length,
      image_candidate_count: imageCandidates,
      shared_source_pool: true,
      acquisition_owner: acquisitionOwner,
      provider_calls: acquisitionOwner ? Number(this.pool.usage.provider_calls ?? 1) : 0,
      total_ms: totalMs,
    });

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
        queriesExecuted: 0,
        coverageNotes: [
          `${sources.length} sources selected from one shared verified research pool.`,
          `${evidence.length} role-specific source-backed evidence claims extracted without another web search.`,
          acquisitionOwner
            ? `This Scout owns the shared acquisition cost (${Number(this.pool.usage.provider_calls ?? 1)} provider call(s)); follower Scouts record zero search calls.`
            : "Shared source pool reused; this Scout started zero paid web-search calls.",
          context.assignment.imageSearchRequired
            ? `${imageCandidates} page image candidates available from the shared source pages.`
            : "Visual-source harvesting was not required for this Scout role.",
        ],
        warnings: [],
        generatedAt,
      }),
      evidenceBundle,
      usage: acquisitionOwner
        ? {
            ...this.pool.usage,
            shared_source_pool: true,
            shared_source_pool_acquisition_owner: true,
            role_analysis_provider_calls: 0,
            total_ms: totalMs,
          }
        : {
            search_calls: 0,
            provider_calls: 0,
            shared_source_pool: true,
            shared_source_pool_reused: true,
            role_analysis_provider_calls: 0,
            total_ms: totalMs,
          },
      model: acquisitionOwner ? "gemini-3-6-flash" : null,
      provider: acquisitionOwner ? "kie" : "shared_source_pool",
    };
  }
}
