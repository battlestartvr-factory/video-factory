export type DiscoveryLlmTask =
  | "concept_exploration"
  | "schema_repair"
  | "concept_pre_evaluation"
  | "gameplay_moment_planning"
  | "shot_planning"
  | "feedback_structuring"
  | "gameplay_reference_captioning";

export type DiscoveryModelTier = "cheap" | "creative" | "top";

export interface DiscoveryLlmPolicy {
  task: DiscoveryLlmTask;
  primaryModel: string;
  tier: DiscoveryModelTier;
  thinking: boolean;
  maxOutputTokens: number;
  maxCallsPerBatch: number;
  fallbackModels: string[];
  automaticEscalation: boolean;
}

/**
 * Stage 4 owns its internal model routing. The chat model only launches the durable job;
 * it must not silently become the worker model. KIE Sonnet has repeatedly returned HTTP
 * 500 for the large structured discovery turns, so the durable path currently uses the
 * proven Gemini OpenAI-compatible endpoints instead.
 */
const POLICIES: Record<DiscoveryLlmTask, DiscoveryLlmPolicy> = {
  concept_exploration: {
    task: "concept_exploration",
    primaryModel: "gemini-3-pro",
    tier: "creative",
    thinking: false,
    maxOutputTokens: 8192,
    maxCallsPerBatch: 4,
    fallbackModels: ["gemini-3-6-flash"],
    automaticEscalation: false,
  },
  schema_repair: {
    task: "schema_repair",
    primaryModel: "gemini-3-6-flash",
    tier: "cheap",
    thinking: false,
    maxOutputTokens: 4096,
    maxCallsPerBatch: 6,
    fallbackModels: [],
    automaticEscalation: false,
  },
  concept_pre_evaluation: {
    task: "concept_pre_evaluation",
    primaryModel: "gemini-3-6-flash",
    tier: "cheap",
    thinking: false,
    maxOutputTokens: 4096,
    maxCallsPerBatch: 2,
    fallbackModels: [],
    automaticEscalation: false,
  },
  gameplay_moment_planning: {
    task: "gameplay_moment_planning",
    primaryModel: "gemini-3-pro",
    tier: "creative",
    thinking: false,
    maxOutputTokens: 6144,
    maxCallsPerBatch: 2,
    fallbackModels: ["gemini-3-6-flash"],
    automaticEscalation: false,
  },
  shot_planning: {
    task: "shot_planning",
    primaryModel: "gemini-3-6-flash",
    tier: "cheap",
    thinking: false,
    maxOutputTokens: 4096,
    maxCallsPerBatch: 2,
    fallbackModels: ["gemini-3-pro"],
    automaticEscalation: true,
  },
  feedback_structuring: {
    task: "feedback_structuring",
    primaryModel: "gemini-3-6-flash",
    tier: "cheap",
    thinking: false,
    maxOutputTokens: 3072,
    maxCallsPerBatch: 2,
    fallbackModels: [],
    automaticEscalation: false,
  },
  gameplay_reference_captioning: {
    task: "gameplay_reference_captioning",
    primaryModel: "gemini-3-6-flash",
    tier: "cheap",
    thinking: false,
    maxOutputTokens: 4096,
    maxCallsPerBatch: 1,
    fallbackModels: [],
    automaticEscalation: false,
  },
};

/**
 * Stage 4 never routes automatically to top-tier frontier models such as GPT 5.6 Sol.
 * A later explicit human override may opt into a top-tier model, but it is outside the
 * automatic discovery loop and must be recorded as a separate approval/cost decision.
 */
export const DISCOVERY_AUTOMATIC_TOP_TIER_ALLOWED = false;

export function getDiscoveryLlmPolicy(task: DiscoveryLlmTask): DiscoveryLlmPolicy {
  return POLICIES[task];
}

export function assertDiscoveryModelAllowed(input: {
  task: DiscoveryLlmTask;
  model: string;
  explicitHumanOverride?: boolean;
}): void {
  const policy = getDiscoveryLlmPolicy(input.task);
  const allowed = new Set([policy.primaryModel, ...policy.fallbackModels]);
  if (allowed.has(input.model)) return;

  if (input.explicitHumanOverride) return;
  throw new Error(`DISCOVERY_MODEL_NOT_ALLOWED:${input.task}:${input.model}`);
}

export function discoveryRoutingSnapshot(): Record<DiscoveryLlmTask, DiscoveryLlmPolicy> {
  return { ...POLICIES };
}
