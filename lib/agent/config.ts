export const AGENT_MAX_TOOL_ITERATIONS = 10;
export const AGENT_MAX_REPEATED_TOOL_FAILURES = 3;
export const AGENT_PROVIDER_TIMEOUT_MS = 60_000;
export const AGENT_RUN_TIMEOUT_MS = 120_000;

export const CONTEXT_BUDGET = {
  recentMessages: 20,
  maxMessageChars: 4000,
  memoryItems: 12,
  maxMemoryChars: 4000,
  knowledgeChunks: 4,
  maxKnowledgeChars: 4000,
  maxAttachmentTextChars: 6000,
  maxSystemPromptChars: 12000,
  maxPersonalizationChars: 2000,
  maxProjectInstructionsChars: 4000,
  maxSummaryChars: 2000,
  maxToolResultChars: 8000,
} as const;

export const CONTENT_LIMITS = {
  maxExtractedTextChars: 50_000,
  knowledgeChunkSize: 1000,
  maxKnowledgeChunksPerDocument: 40,
  maxWebFetchBytes: 500_000,
  maxWebFetchChars: 20_000,
  maxWebSearchResults: 8,
  maxWebFetchRedirects: 3,
  webFetchTimeoutMs: 10_000,
  maxImageOutputs: 4,
  maxVideoOutputs: 4,
} as const;

export const DEFAULT_IMAGE_MODEL = "gpt-image-2";
export const DEFAULT_VIDEO_MODEL = "kling-3";
export const DEFAULT_LLM_MODEL = "gemini-3-6-flash";
export const DEFAULT_REASONING_LEVEL = "medium" as const;
export const DEFAULT_MEDIA_QUALITY = "medium" as const;

export const AGENT_ERROR_CODES = {
  PROVIDER_NOT_CONFIGURED: "AGENT_PROVIDER_NOT_CONFIGURED",
  WEB_SEARCH_NOT_CONFIGURED: "WEB_SEARCH_NOT_CONFIGURED",
  WEB_FETCH_UNSAFE_URL: "WEB_FETCH_UNSAFE_URL",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  TOOL_NOT_FOUND: "TOOL_NOT_FOUND",
  TOOL_LIMIT_REACHED: "TOOL_LIMIT_REACHED",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  MODEL_NOT_ALLOWED: "MODEL_NOT_ALLOWED",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  MODEL_NOT_SUPPORTED: "MODEL_NOT_SUPPORTED",
  MODEL_CAPABILITY_MISMATCH: "MODEL_CAPABILITY_MISMATCH",
  MODEL_CAPABILITY_MISSING: "MODEL_CAPABILITY_MISSING",
  INVALID_REASONING_LEVEL: "INVALID_REASONING_LEVEL",
  INVALID_QUALITY_LEVEL: "INVALID_QUALITY_LEVEL",
  PROVIDER_RATE_LIMIT: "PROVIDER_RATE_LIMIT",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  EXTRACT_UNAVAILABLE: "EXTRACT_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;
