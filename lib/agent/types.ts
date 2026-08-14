import type { z } from "zod";
import type {
  ChatAttachment,
  GenerationCardData,
  SourceCitation,
  TaskCardData,
} from "@/lib/types/workspace";

export type AgentRole = "system" | "user" | "assistant" | "tool";

export interface AgentContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentMessage {
  role: AgentRole;
  content: string | AgentContentPart[] | null;
  toolCalls?: AgentToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface AgentRequest {
  messages: AgentMessage[];
  tools: AgentToolDefinition[];
  model: string;
  system: string;
}

export interface AgentUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AgentProviderResponse {
  content: string | null;
  toolCalls: AgentToolCall[];
  usage?: AgentUsage;
  finishReason?: "stop" | "tool_calls" | "length" | "error";
}

export interface AgentProvider {
  run(input: AgentRequest): Promise<AgentProviderResponse>;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ToolRisk = "safe" | "destructive";

export interface ToolResult {
  ok: boolean;
  code?: string;
  error?: string;
  data?: unknown;
  generation?: GenerationCardData;
  generations?: GenerationCardData[];
  sources?: SourceCitation[];
  task?: TaskCardData;
  userContent?: string;
  terminate?: boolean;
}

export interface ToolContext {
  requestId: string;
  userId: string;
  chatId: string;
  projectId: string | null;
  userMessageId: string;
  agentRunId: string;
  userMessage: string;
  attachments: ChatAttachment[];
}

export interface AgentTool<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  risk: ToolRisk;
  handler: (input: TInput, ctx: ToolContext) => Promise<ToolResult>;
}

export interface AnyAgentTool {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  risk: ToolRisk;
  handler: (input: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

export type AgentEventType =
  | "run_started"
  | "tool_started"
  | "tool_finished"
  | "generation_created"
  | "final"
  | "error";

export interface AgentEvent {
  type: AgentEventType;
  toolName?: string;
  toolRunId?: string;
  generationId?: string;
  actionId?: string;
  status?: string;
  label?: string;
  errorCode?: string;
  at: string;
}

export interface BuiltAgentContext {
  systemPrompt: string;
  history: AgentMessage[];
  currentUserMessage: AgentMessage;
  attachments: ChatAttachment[];
  visionImageUrls: string[];
}
