export type ChatRole = "user" | "assistant" | "system";
export type PresetType = "chat" | "image" | "video";
export type MemoryScope = "global" | "project";
export type GenerationType = "image" | "video";
export type GenerationStatus =
  | "pending"
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";
export type KnowledgeDocStatus = "pending" | "processing" | "ready" | "failed";

export interface Chat {
  id: string;
  user_id: string;
  project_id: string | null;
  title: string;
  summary: string | null;
  model_id: string | null;
  preset_id: string | null;
  metadata: Record<string, unknown>;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  chat_id: string;
  role: ChatRole;
  content: string;
  metadata: MessageMetadata;
  created_at: string;
}

export interface MessageMetadata {
  type?: "text" | "task" | "generation" | "error" | "sources" | "agent";
  task?: TaskCardData;
  tasks?: TaskCardData[];
  generation?: GenerationCardData;
  generations?: GenerationCardData[];
  error?: ErrorCardData;
  sources?: SourceCitation[];
  attachments?: string[];
  agentRunId?: string;
  events?: AgentUiEvent[];
}

export interface AgentUiEvent {
  type: string;
  toolName?: string;
  label?: string;
  status?: string;
}

export interface TaskCardData {
  action: string;
  model?: string;
  prompt?: string;
  settings?: Record<string, unknown>;
  jobId?: string;
  factoryJobId?: string;
  status: string;
  progress?: number;
  outputs?: Array<{ url?: string; kind?: string }>;
}

export interface GenerationCardData {
  generationId: string;
  type: GenerationType;
  mode: string;
  status: GenerationStatus;
  prompt: string;
  modelId: string;
  modelName?: string;
  quality?: string;
  outputs?: Array<{ url?: string; kind?: string }>;
}

export interface ErrorCardData {
  code?: string;
  message: string;
  retryable?: boolean;
}

export interface SourceCitation {
  title?: string;
  filename?: string;
  documentId?: string;
  url?: string;
  domain?: string;
  publishedAt?: string;
  snippet?: string;
  excerpt?: string;
  chunkIndex?: number;
  source?: "knowledge" | "web";
}

export interface ChatAttachment {
  id: string;
  chat_id: string;
  message_id: string | null;
  user_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number | null;
  storage_path: string | null;
  url: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ChatJobLink {
  id: string;
  chat_id: string;
  message_id: string | null;
  job_id: string | null;
  factory_job_id: string | null;
  action: Record<string, unknown>;
  created_at: string;
}

export interface Preset {
  id: string;
  user_id: string | null;
  type: PresetType;
  name: string;
  is_system: boolean;
  is_default: boolean;
  settings: PresetSettings;
  created_at: string;
  updated_at: string;
}

export interface PresetSettings {
  systemPrompt?: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  duration?: number;
  numOutputs?: number;
  [key: string]: unknown;
}

export interface MemoryItem {
  id: string;
  user_id: string;
  scope: MemoryScope;
  project_id: string | null;
  content: string;
  category: string | null;
  source: string | null;
  importance: number;
  pinned: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserPreferences {
  user_id: string;
  personalization: PersonalizationSettings;
  appearance: AppearanceSettings;
  created_at: string;
  updated_at: string;
}

export interface PersonalizationSettings {
  aboutMe?: string;
  communicationStyle?: string;
  globalInstructions?: string;
  preferredLanguage?: string;
  agentBehavior?: string;
}

export interface AppearanceSettings {
  theme?: "dark" | "light" | "system";
  accentColor?: string;
  font?: "geist" | "system" | "mono";
  density?: "comfortable" | "compact";
}

export interface KnowledgeBase {
  id: string;
  user_id: string;
  project_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeDocument {
  id: string;
  knowledge_base_id: string;
  user_id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  storage_path: string | null;
  source: string | null;
  status: KnowledgeDocStatus;
  extracted_text: string | null;
  metadata: Record<string, unknown>;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface KnowledgeChunk {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface Generation {
  id: string;
  user_id: string;
  type: GenerationType;
  mode: string;
  prompt: string;
  model_id: string;
  preset_id: string | null;
  settings: Record<string, unknown>;
  reference_assets: Array<{
    id?: string;
    url?: string;
    mimeType?: string;
    filename?: string;
    role?: string;
  }>;
  project_id: string | null;
  chat_id: string | null;
  message_id: string | null;
  status: GenerationStatus;
  outputs: Array<{ url?: string; kind?: string; mimeType?: string }>;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type AgentRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type AgentToolRunStatus = "running" | "completed" | "failed" | "skipped";
export type AgentActionStatus =
  | "pending_dispatch"
  | "dispatched"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentRun {
  id: string;
  request_id: string;
  user_id: string;
  chat_id: string;
  project_id: string | null;
  user_message_id: string | null;
  assistant_message_id: string | null;
  model: string | null;
  status: AgentRunStatus;
  started_at: string;
  finished_at: string | null;
  usage: Record<string, unknown>;
  error_code: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AgentToolRun {
  id: string;
  agent_run_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  status: AgentToolRunStatus;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface AgentAction {
  id: string;
  agent_run_id: string | null;
  user_id: string;
  chat_id: string | null;
  project_id: string | null;
  generation_id: string | null;
  source_message_id: string | null;
  action_type: string;
  status: AgentActionStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModelCapabilities {
  chat?: boolean;
  vision?: boolean;
  toolCalling?: boolean;
  imageGeneration?: boolean;
  videoGeneration?: boolean;
  startFrame?: boolean;
  endFrame?: boolean;
  referenceImages?: boolean;
  referenceVideo?: boolean;
  audio?: boolean;
  resolutions?: string[];
  aspectRatios?: string[];
  durations?: number[];
}

export interface AIModel {
  id: string;
  provider: string;
  name: string;
  type: "chat" | "image" | "video";
  capabilities: ModelCapabilities;
}
