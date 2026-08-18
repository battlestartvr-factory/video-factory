export type DiscoveryLlmTask =
  | "concept_exploration"
  | "schema_repair"
  | "concept_pre_evaluation"
  | "gameplay_moment_planning"
  | "shot_planning"
  | "feedback_structuring";

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

const POLICIES: Record<DiscoveryLlmTask, DiscoveryLlmPolicy> = {
  concept_exploration: {
    task: "concept_exploration",
    primaryModel: "claude-sonnet-5",
    tier: "creative",
    // Stage 4 asks for large, strict JSON payloads. KIE's extended-thinking path can
    // hold these requests long enough for the upstream gateway to return HTTP 500.
    // Standard Sonnet is the production-safe path and is also what the chat UI uses.
    thinking: false,
    maxOutputTokens: 8192,
    maxCallsPerBatch: 4,
    fallbackModels: [],
    automaticEscalation: false,
  },
  schema_repair: {
    task: "schema_repair",
    primaryModel: "claude-haiku-4-5",
    tier: "cheap",
    thinking: false,
    maxOutputTokens: 4096,
    maxCallsPerBatch: 6,
    fallbackModels: ["gemini-3-6-flash"],
    automaticEscalation: false,
  },
  concept_pre_evaluation: {
    task: "concept_pre_evaluation",
    primaryModel: "claude-haiku-4-5",
    tier: "cheap",
    thinking: false,
    maxOutputTokens: 4096,
    maxCallsPerBatch: 2,
    fallbackModels: ["gemini-3-6-flash"],
    automaticEscalation: false,
  },
  gameplay_moment_planning: {
    task: "gameplay_moment_planning",
    primaryModel: "claude-sonnet-5",
    tier: "creative",
    // Keep the durable pipeline on the same proven KIE Claude request mode as chat.
    // The structured planning prompt already provides the required deliberation frame.
    thinking: false,
    maxOutputTokens: 6144,
    maxCallsPerBatch: 2,
    fallbackModels: [],
    automaticEscalation: false,
  },
  shot_planning: {
    task: "shot_planning",
    primaryModel: "claude-haiku-4-5",
    tier: "cheap",
    thinking: false,
    maxOutputTokens: 4096,
    maxCallsPerBatch: 2,
    fallbackModels: ["claude-sonnet-5"],
    automaticEscalation: true,
  },
  feedback_structuring: {
    task: "feedback_structuring",
    primaryModel: "claude-haiku-4-5",
    tier: "cheap",
    thinking: false,
    maxOutputTokens: 3072,
    maxCallsPerBatch: 2,
    fallbackModels: ["gemini-3-6-flash"],
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
