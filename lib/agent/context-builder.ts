import { CONTEXT_BUDGET, AGENT_ERROR_CODES } from "./config";
import { AGENT_RUNTIME_POLICY, AGENT_RUNTIME_POLICY_VERSION } from "./runtime-policy";
import { PRODUCT_MISSION, PRODUCT_MISSION_VERSION } from "./product-mission";
import {
  AGENT_OPERATING_INSTRUCTIONS_VERSION,
  DEFAULT_GLOBAL_AGENT_INSTRUCTIONS,
} from "./default-agent-instructions";
import { truncateText } from "./redaction";
import type { AgentConfig } from "./agent-config-service";
import type { Chat, ChatAttachment, ChatMessage, MemoryItem } from "@/lib/types/workspace";
import type { Project } from "@/lib/types/database";
import type { AgentContentPart, AgentMessage } from "./types";
import { getCategoryFromMime } from "@/lib/attachments/mime";
import { getModelById } from "@/lib/models/registry";

export interface ContextSources {
  chat: Chat;
  project: Project | null;
  /** @deprecated User agent configs are ignored; operating instructions are code-controlled. */
  agentConfig?: AgentConfig | null;
  /** @deprecated Presets no longer participate in agent context. */
  preset?: unknown;
  /** @deprecated Personalization no longer participates in agent context. */
  preferences?: unknown;
  memory: MemoryItem[];
  knowledgeNotes: string[];
  recentMessages: ChatMessage[];
  attachments: ChatAttachment[];
  currentMessage: ChatMessage;
  modelId: string;
}

export interface ContextManifest {
  runtime_policy_version: string;
  product_mission_version: string;
  agent_operating_instructions_version: string;
  /** Compatibility fields retained for existing logs/clients. */
  agent_config_id: string | null;
  agent_config_version: number | null;
  personalization_present: boolean;
  global_memory_items: number;
  project_id: string | null;
  project_memory_items: number;
  knowledge_chunks: number;
  chat_messages: number;
  current_user_message_chars: number;
  model: string;
  preset_id: string | null;
}

export interface ContextLayerPreview {
  id: string;
  title: string;
  source: string;
  present: boolean;
  editable: boolean;
  charCount: number;
  itemCount?: number;
  text?: string;
}

export interface AgentContext {
  runtimePolicy: { version: string; text: string };
  productMission: { version: string; text: string };
  agentInstructions: { configId: string | null; version: number | null; text: string };
  /** @deprecated Always empty. */
  presetInstructions: { presetId: null; presetName: null; text: string };
  /** @deprecated Always empty. */
  personalization: Record<string, never>;
  globalMemory: MemoryItem[];
  projectInstructions: {
    projectId: string | null;
    name?: string;
    description?: string;
    text?: string;
    language?: string;
    platforms?: string[];
    absentNote?: string;
  };
  projectMemory: MemoryItem[];
  retrievedKnowledge: string[];
  chatSummary: string | null;
  recentMessages: AgentMessage[];
  currentUserMessage: AgentMessage;
  visionImageUrls: string[];
  manifest: ContextManifest;
  /** Provider-neutral assembled instructions (system prompt). */
  instructions: string;
  /** Chat history excluding current turn. */
  messages: AgentMessage[];
  /** Alias for currentUserMessage — required invariant for providers. */
  currentTurn: AgentMessage;
}

/** @deprecated Use AgentContext.instructions */
export interface AssembledContext {
  systemPrompt: string;
  history: AgentMessage[];
  currentUserMessage: AgentMessage;
  visionImageUrls: string[];
  manifest?: ContextManifest;
}

export class AgentContextError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function section(title: string, body: string | null | undefined, max: number): string {
  if (!body?.trim()) return "";
  return `\n\n## ${title}\n${truncateText(body.trim(), max)}`;
}

function extractMessageText(message: AgentMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part): part is AgentContentPart & { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
  }
  return "";
}

export function assertCurrentUserMessage(message: AgentMessage): void {
  if (!extractMessageText(message).trim()) {
    throw new AgentContextError(
      AGENT_ERROR_CODES.CURRENT_USER_MESSAGE_MISSING,
      "Current user message is required and cannot be empty",
    );
  }
}

export function modelSupportsVision(modelId: string): boolean {
  const model = getModelById(modelId);
  if (model?.capabilities.vision) return true;
  return /gpt-4o|gemini|claude|vision/i.test(modelId);
}

function formatMemoryItems(items: MemoryItem[]): string {
  return items
    .map((item) => {
      const meta = [
        item.scope,
        item.source ? `source=${item.source}` : "",
        item.confidence != null ? `confidence=${item.confidence}` : "",
        item.pinned ? "pinned" : "",
      ].filter(Boolean);
      return `- [${meta.join(", ")}] ${item.content}`;
    })
    .join("\n");
}

function buildProjectBlock(project: Project | null): AgentContext["projectInstructions"] {
  if (!project) {
    return {
      projectId: null,
      absentNote: "This chat is not inside a project. project_id is null. Do not invent a project.",
    };
  }
  return {
    projectId: project.id,
    name: project.name,
    description: project.description ?? undefined,
    text: project.system_prompt ?? undefined,
    language: project.default_language,
    platforms: project.target_platforms ?? undefined,
  };
}

function projectInstructionsText(projectBlock: AgentContext["projectInstructions"]): string {
  if (projectBlock.absentNote) return projectBlock.absentNote;
  return [
    projectBlock.name ? `Name: ${projectBlock.name}` : "",
    projectBlock.description ? `Description: ${projectBlock.description}` : "",
    projectBlock.text ? `Instructions:\n${projectBlock.text}` : "",
    projectBlock.language ? `Language: ${projectBlock.language}` : "",
    projectBlock.platforms?.length ? `Platforms: ${projectBlock.platforms.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Assemble system prompt with explicit product-first priority ordering and budget trimming. */
export function assembleInstructions(layers: {
  runtimePolicy: string;
  productMission?: string;
  agentInstructions: string;
  globalMemory: string;
  projectInstructions: string;
  projectMemory: string;
  knowledge: string;
  chatSummary: string;
  /** @deprecated Ignored. */
  presetInstructions?: string;
  /** @deprecated Ignored. */
  personalization?: string;
}): string {
  const neverDrop = [
    { key: "runtimePolicy", text: layers.runtimePolicy, max: CONTEXT_BUDGET.maxRuntimePolicyChars },
    { key: "productMission", text: layers.productMission ?? PRODUCT_MISSION, max: 6000 },
    { key: "agentInstructions", text: layers.agentInstructions, max: CONTEXT_BUDGET.maxAgentInstructionsChars },
  ] as const;

  const droppable = [
    { key: "projectInstructions", text: layers.projectInstructions, max: CONTEXT_BUDGET.maxProjectInstructionsChars },
    { key: "globalMemory", text: layers.globalMemory, max: CONTEXT_BUDGET.maxMemoryChars },
    { key: "projectMemory", text: layers.projectMemory, max: CONTEXT_BUDGET.maxMemoryChars },
    { key: "knowledge", text: layers.knowledge, max: CONTEXT_BUDGET.maxKnowledgeChars },
    { key: "chatSummary", text: layers.chatSummary, max: CONTEXT_BUDGET.maxSummaryChars },
  ] as const;

  const sectionTitles: Record<string, string> = {
    runtimePolicy: "Runtime Policy",
    productMission: "Product Mission",
    agentInstructions: "Agent Operating Instructions",
    projectInstructions: "Project instructions",
    globalMemory: "Evidence-backed global memory",
    projectMemory: "Evidence-backed project memory",
    knowledge: "Relevant knowledge / source evidence (partial retrieval)",
    chatSummary: "Chat summary",
  };

  const parts: string[] = [];
  let totalChars = 0;

  for (const layer of neverDrop) {
    if (!layer.text.trim()) continue;
    const chunk = section(sectionTitles[layer.key], layer.text, layer.max);
    parts.push(chunk);
    totalChars += chunk.length;
  }

  for (const layer of droppable) {
    if (!layer.text.trim()) continue;
    let chunk = section(sectionTitles[layer.key], layer.text, layer.max);
    if (totalChars + chunk.length > CONTEXT_BUDGET.maxSystemPromptChars) {
      const remaining = CONTEXT_BUDGET.maxSystemPromptChars - totalChars;
      if (remaining <= 80) continue;
      chunk = section(sectionTitles[layer.key], layer.text, Math.min(layer.max, remaining - 20));
    }
    if (!chunk.trim()) continue;
    parts.push(chunk);
    totalChars += chunk.length;
  }

  return truncateText(parts.join(""), CONTEXT_BUDGET.maxSystemPromptChars);
}

export function buildAgentContext(sources: ContextSources): AgentContext {
  const globalMemory = sources.memory.filter((item) => item.scope === "global");
  const projectMemory = sources.memory.filter((item) => item.scope === "project");
  const projectBlock = buildProjectBlock(sources.project);
  const agentInstructionsText = DEFAULT_GLOBAL_AGENT_INSTRUCTIONS;

  const prior = sources.recentMessages.filter((message) => message.id !== sources.currentMessage.id);
  const history = historyToAgentMessages(prior);
  const current = buildCurrentUserMessage(sources.currentMessage, sources.attachments, sources.modelId);

  assertCurrentUserMessage(current.message);

  const instructions = assembleInstructions({
    runtimePolicy: AGENT_RUNTIME_POLICY,
    productMission: PRODUCT_MISSION,
    agentInstructions: agentInstructionsText,
    globalMemory: formatMemoryItems(globalMemory),
    projectInstructions: projectInstructionsText(projectBlock),
    projectMemory: formatMemoryItems(projectMemory),
    knowledge: sources.knowledgeNotes.join("\n\n"),
    chatSummary: sources.chat.summary ?? "",
  });

  const currentText = extractMessageText(current.message);
  const manifest: ContextManifest = {
    runtime_policy_version: AGENT_RUNTIME_POLICY_VERSION,
    product_mission_version: PRODUCT_MISSION_VERSION,
    agent_operating_instructions_version: AGENT_OPERATING_INSTRUCTIONS_VERSION,
    agent_config_id: null,
    agent_config_version: null,
    personalization_present: false,
    global_memory_items: globalMemory.length,
    project_id: sources.project?.id ?? null,
    project_memory_items: projectMemory.length,
    knowledge_chunks: sources.knowledgeNotes.length,
    chat_messages: history.length,
    current_user_message_chars: currentText.length,
    model: sources.modelId,
    preset_id: null,
  };

  return {
    runtimePolicy: { version: AGENT_RUNTIME_POLICY_VERSION, text: AGENT_RUNTIME_POLICY },
    productMission: { version: PRODUCT_MISSION_VERSION, text: PRODUCT_MISSION },
    agentInstructions: {
      configId: null,
      version: Number(AGENT_OPERATING_INSTRUCTIONS_VERSION),
      text: agentInstructionsText,
    },
    presetInstructions: { presetId: null, presetName: null, text: "" },
    personalization: {},
    globalMemory,
    projectInstructions: projectBlock,
    projectMemory,
    retrievedKnowledge: sources.knowledgeNotes,
    chatSummary: sources.chat.summary,
    recentMessages: history,
    currentUserMessage: current.message,
    visionImageUrls: current.visionImageUrls,
    manifest,
    instructions,
    messages: history,
    currentTurn: current.message,
  };
}

/** @deprecated Use buildAgentContext */
export function assembleContext(sources: ContextSources): AssembledContext {
  const ctx = buildAgentContext(sources);
  return {
    systemPrompt: ctx.instructions,
    history: ctx.messages,
    currentUserMessage: ctx.currentTurn,
    visionImageUrls: ctx.visionImageUrls,
    manifest: ctx.manifest,
  };
}

/** @deprecated Use assembleInstructions via buildAgentContext */
export function assembleSystemPrompt(sources: ContextSources): string {
  return buildAgentContext(sources).instructions;
}

export function buildContextPreview(context: AgentContext): ContextLayerPreview[] {
  const projectText = context.projectInstructions.absentNote ?? projectInstructionsText(context.projectInstructions);

  return [
    {
      id: "runtimePolicy",
      title: "Technical Runtime Policy",
      source: `Runtime Policy v${context.runtimePolicy.version}`,
      present: true,
      editable: false,
      charCount: context.runtimePolicy.text.length,
      text: context.runtimePolicy.text,
    },
    {
      id: "productMission",
      title: "Product Mission",
      source: `Product Constitution layer v${context.productMission.version}`,
      present: true,
      editable: false,
      charCount: context.productMission.text.length,
      text: context.productMission.text,
    },
    {
      id: "agentInstructions",
      title: "Agent Operating Instructions",
      source: `Code-controlled v${context.agentInstructions.version ?? 1}`,
      present: true,
      editable: false,
      charCount: context.agentInstructions.text.length,
      text: context.agentInstructions.text,
    },
    {
      id: "projectInstructions",
      title: "Project instructions",
      source: context.projectInstructions.projectId ? context.projectInstructions.name ?? "Project" : "No project",
      present: !!projectText.trim(),
      editable: true,
      charCount: projectText.length,
      text: projectText || undefined,
    },
    {
      id: "globalMemory",
      title: "Evidence-backed Global Memory",
      source: "Memory / Learnings",
      present: context.globalMemory.length > 0,
      editable: false,
      charCount: formatMemoryItems(context.globalMemory).length,
      itemCount: context.globalMemory.length,
      text: formatMemoryItems(context.globalMemory) || undefined,
    },
    {
      id: "projectMemory",
      title: "Evidence-backed Project Memory",
      source: context.projectInstructions.projectId ? "Project learnings" : "No project",
      present: context.projectMemory.length > 0,
      editable: false,
      charCount: formatMemoryItems(context.projectMemory).length,
      itemCount: context.projectMemory.length,
      text: formatMemoryItems(context.projectMemory) || undefined,
    },
    {
      id: "knowledge",
      title: "Knowledge / Source Evidence",
      source: "Retrieved chunks",
      present: context.retrievedKnowledge.length > 0,
      editable: false,
      charCount: context.retrievedKnowledge.join("\n\n").length,
      itemCount: context.retrievedKnowledge.length,
      text: context.retrievedKnowledge.join("\n\n") || undefined,
    },
    {
      id: "chat",
      title: "Chat",
      source: "Recent messages",
      present: context.recentMessages.length > 0 || !!context.chatSummary,
      editable: false,
      charCount: context.recentMessages.reduce((sum, m) => sum + extractMessageText(m).length, 0),
      itemCount: context.recentMessages.length,
      text: [
        context.chatSummary ? `Summary: ${context.chatSummary}` : "Summary: none",
        ...context.recentMessages.map((m) => `[${m.role}] ${extractMessageText(m)}`),
      ].join("\n"),
    },
    {
      id: "currentRequest",
      title: "Current request",
      source: "Current user message",
      present: true,
      editable: false,
      charCount: extractMessageText(context.currentTurn).length,
      text: extractMessageText(context.currentTurn),
    },
  ];
}

function attachmentNote(attachment: ChatAttachment): string {
  const category = getCategoryFromMime(attachment.mime_type) ?? "file";
  if (category === "video") {
    return `[video attachment id=${attachment.id} filename="${attachment.filename}" mime=${attachment.mime_type}. Raw video is not sent to the model.]`;
  }
  if (category === "image") {
    return `[image attachment id=${attachment.id} filename="${attachment.filename}"]`;
  }
  return `[document attachment id=${attachment.id} filename="${attachment.filename}" mime=${attachment.mime_type}. Use inspect_attachment / extract_document.]`;
}

export function buildCurrentUserMessage(
  message: ChatMessage,
  attachments: ChatAttachment[],
  modelId: string,
): { message: AgentMessage; visionImageUrls: string[] } {
  const vision = modelSupportsVision(modelId);
  const notes = attachments.map(attachmentNote);
  const text = [message.content, notes.length ? notes.join("\n") : ""].filter(Boolean).join("\n\n");
  const visionImageUrls = vision
    ? attachments
        .filter((att) => att.mime_type.startsWith("image/") && att.url?.startsWith("http"))
        .map((att) => att.url!)
        .slice(0, 4)
    : [];

  if (!visionImageUrls.length) {
    return { message: { role: "user", content: truncateText(text, CONTEXT_BUDGET.maxMessageChars) }, visionImageUrls };
  }

  const parts: AgentContentPart[] = [
    { type: "text", text: truncateText(text, CONTEXT_BUDGET.maxMessageChars) },
    ...visionImageUrls.map((url) => ({ type: "image_url" as const, image_url: { url } })),
  ];
  return { message: { role: "user", content: parts }, visionImageUrls };
}

export function historyToAgentMessages(messages: ChatMessage[]): AgentMessage[] {
  return messages.slice(-CONTEXT_BUDGET.recentMessages).map((message) => ({
    role: message.role === "system" ? "system" : message.role,
    content: truncateText(message.content || "", CONTEXT_BUDGET.maxMessageChars),
  }));
}

export { AGENT_RUNTIME_POLICY_VERSION };
