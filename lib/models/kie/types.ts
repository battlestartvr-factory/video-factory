/** Canonical application-level reasoning levels */
export type ReasoningLevel = "low" | "medium" | "high" | "max";

/** Canonical application-level media quality levels */
export type MediaQuality = "low" | "medium" | "high";

export type ModelCategory = "llm" | "image" | "video";

/** Future categories — registry architecture supports extension without redesign */
export type FutureModelCategory =
  | ModelCategory
  | "audio"
  | "music"
  | "speech"
  | "video_edit"
  | "upscale";

export type KieAdapterKind =
  | "openai_chat"
  | "responses"
  | "claude_messages"
  | "market_task"
  | "veo";

export type ReasoningControl = "effort" | "binary" | "adaptive" | "none";

export type SelectionSource = "user" | "ui" | "preset" | "agent" | "default";

export interface ReasoningConfig {
  control: ReasoningControl;
  /** Application-level levels exposed in UI */
  levels: Array<ReasoningLevel | "off" | "on">;
  default: ReasoningLevel | "off" | "on";
  /** Maps application level → provider-native value */
  mapping: Record<string, string>;
}

export interface QualityConfig {
  /** Application-level levels exposed in UI */
  levels: MediaQuality[];
  default: MediaQuality;
  /** Maps application level → provider-native value */
  mapping: Record<MediaQuality, string>;
}

export interface ModelCapabilities {
  chat?: boolean;
  vision?: boolean;
  toolCalling?: boolean;
  imageGeneration?: boolean;
  videoGeneration?: boolean;
  textToImage?: boolean;
  imageToImage?: boolean;
  imageEdit?: boolean;
  textToVideo?: boolean;
  imageToVideo?: boolean;
  referenceToVideo?: boolean;
  videoEdit?: boolean;
  startFrame?: boolean;
  endFrame?: boolean;
  multiShot?: boolean;
  elementReferences?: boolean;
  referenceImages?: boolean;
  referenceVideo?: boolean;
  audio?: boolean;
  sound?: boolean;
  typography?: boolean;
  multiReference?: boolean;
  highResolution?: boolean;
  /** Supported aspect ratios */
  aspectRatios?: string[];
  /** Supported resolutions (when not quality-mapped) */
  resolutions?: string[];
  durations?: number[];
  maxReferenceImages?: number;
}

export interface KieModelEntry {
  id: string;
  displayName: string;
  provider: "kie";
  category: ModelCategory;
  adapter: KieAdapterKind;
  /** Path relative to KIE_API_BASE_URL */
  endpoint: string;
  /** Provider-native model identifier sent in API requests */
  providerModel: string;
  capabilities: ModelCapabilities;
  reasoning?: ReasoningConfig;
  quality?: QualityConfig;
  defaults?: {
    isDefault?: boolean;
  };
  enabled: boolean;
  /** Nullable — only set when reliable cost data exists */
  relativeCost?: number | null;
  estimatedCost?: number | null;
  /** Legacy alias IDs for backward compatibility */
  aliases?: string[];
  useCases?: string[];
}

export interface PublicModelMetadata {
  id: string;
  displayName: string;
  category: ModelCategory;
  capabilities: ModelCapabilities;
  reasoning?: Pick<ReasoningConfig, "control" | "levels" | "default">;
  quality?: Pick<QualityConfig, "levels" | "default">;
  defaults?: { isDefault?: boolean };
  enabled: boolean;
}

export interface ResolvedReasoning {
  requestedReasoning: ReasoningLevel | "off" | "on";
  effectiveReasoning: string;
  providerParam: Record<string, unknown>;
}

export interface ResolvedQuality {
  requestedQuality: MediaQuality;
  effectiveQuality: string;
  providerParam: Record<string, unknown>;
}

export interface GenerationModelMetadata {
  model_id: string;
  requested_quality?: MediaQuality;
  effective_quality?: string;
  requested_reasoning?: ReasoningLevel | "off" | "on";
  effective_reasoning?: string;
  selection_source: SelectionSource;
}

export type MediaIntent =
  | "generate_image"
  | "generate_video"
  | "edit_video"
  | "assemble_short"
  | "pending_dispatch";

export const PROVIDER_ERROR_CODES = {
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  MODEL_NOT_SUPPORTED: "MODEL_NOT_SUPPORTED",
  MODEL_CAPABILITY_MISMATCH: "MODEL_CAPABILITY_MISMATCH",
  INVALID_REASONING_LEVEL: "INVALID_REASONING_LEVEL",
  INVALID_QUALITY_LEVEL: "INVALID_QUALITY_LEVEL",
  PROVIDER_RATE_LIMIT: "PROVIDER_RATE_LIMIT",
  CLAUDE_REQUEST_INVALID: "CLAUDE_REQUEST_INVALID",
  PROVIDER_ERROR: "PROVIDER_ERROR",
} as const;
