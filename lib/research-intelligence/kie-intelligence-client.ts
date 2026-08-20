import { DurableWorkflowError } from "../orchestrator/retry";
import {
  conceptDesignerOutputSpecV1Schema,
  curatedConceptBatchSpecV1Schema,
  type ConceptCouncilDesignerExecutor,
} from "./concept-council";
import type { ConceptCouncilCuratorExecutor } from "./concept-curator";
import { evidencePackSpecV1Schema } from "./schemas";
import type { ResearchSynthesizerExecutor } from "./synthesis";

function internalAppUrl(): string {
  return (process.env.WORKER_APP_INTERNAL_URL ?? "http://app:3000").trim().replace(/\/+$/, "") || "http://app:3000";
}

async function executeInternal(input: {
  serviceRoleKey: string;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const response = await fetch(`${internalAppUrl()}/api/internal/research-intelligence-execute`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input.payload),
    signal: input.signal,
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // Keep provider HTML/plain-text failures out of the workflow state.
  }
  if (!response.ok || body.ok !== true) {
    const retryable = body.retryable === true || response.status === 429 || response.status >= 500;
    throw new DurableWorkflowError({
      code: typeof body.code === "string" ? body.code : "KIE_INTELLIGENCE_INTERNAL_FAILED",
      message: typeof body.message === "string"
        ? body.message
        : `Internal KIE intelligence execution failed with ${response.status}`,
      retryable,
    });
  }
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new DurableWorkflowError({
      code: "KIE_INTELLIGENCE_INTERNAL_INVALID",
      message: "Internal KIE intelligence response is missing typed data",
      retryable: false,
    });
  }
  return data as Record<string, unknown>;
}

export class InternalKieResearchSynthesizer implements ResearchSynthesizerExecutor {
  constructor(private readonly serviceRoleKey: string) {}

  async synthesize(input: Parameters<ResearchSynthesizerExecutor["synthesize"]>[0]) {
    const data = await executeInternal({
      serviceRoleKey: this.serviceRoleKey,
      payload: { operation: "research_synthesis", synthesisInput: input.synthesisInput },
      signal: input.signal,
    });
    return {
      pack: evidencePackSpecV1Schema.parse(data.pack),
      provider: typeof data.provider === "string" ? data.provider : "kie",
      model: typeof data.model === "string" ? data.model : null,
      usage: data.usage && typeof data.usage === "object" && !Array.isArray(data.usage)
        ? data.usage as Record<string, unknown>
        : {},
      rawResponse: data.rawResponse && typeof data.rawResponse === "object" && !Array.isArray(data.rawResponse)
        ? data.rawResponse as Record<string, unknown>
        : undefined,
    };
  }
}

export class InternalKieConceptDesigner implements ConceptCouncilDesignerExecutor {
  constructor(private readonly serviceRoleKey: string) {}

  async execute(input: Parameters<ConceptCouncilDesignerExecutor["execute"]>[0]) {
    const data = await executeInternal({
      serviceRoleKey: this.serviceRoleKey,
      payload: {
        operation: "concept_designer",
        objective: input.objective,
        evidencePack: input.evidencePack,
        designerRole: input.designerRole,
      },
      signal: input.signal,
    });
    return {
      output: conceptDesignerOutputSpecV1Schema.parse(data.output),
      provider: typeof data.provider === "string" ? data.provider : "kie",
      model: typeof data.model === "string" ? data.model : null,
      usage: data.usage && typeof data.usage === "object" && !Array.isArray(data.usage)
        ? data.usage as Record<string, unknown>
        : {},
    };
  }
}

export class InternalKieConceptCurator implements ConceptCouncilCuratorExecutor {
  constructor(private readonly serviceRoleKey: string) {}

  async execute(input: Parameters<ConceptCouncilCuratorExecutor["execute"]>[0]) {
    const data = await executeInternal({
      serviceRoleKey: this.serviceRoleKey,
      payload: {
        operation: "concept_curator",
        candidates: input.candidates,
        evidencePack: input.evidencePack,
        history: input.history ?? [],
      },
      signal: input.signal,
    });
    const rejected = Array.isArray(data.rejected)
      ? data.rejected.flatMap((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return [];
          const row = value as Record<string, unknown>;
          if (typeof row.candidateId !== "string") return [];
          return [{
            candidateId: row.candidateId,
            reasons: Array.isArray(row.reasons) ? row.reasons.filter((item): item is string => typeof item === "string") : [],
          }];
        })
      : [];
    return {
      batch: curatedConceptBatchSpecV1Schema.parse(data.batch),
      rejected,
      provider: typeof data.provider === "string" ? data.provider : "kie",
      model: typeof data.model === "string" ? data.model : null,
      usage: data.usage && typeof data.usage === "object" && !Array.isArray(data.usage)
        ? data.usage as Record<string, unknown>
        : {},
    };
  }
}
