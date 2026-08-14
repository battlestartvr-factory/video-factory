import { CONTEXT_BUDGET } from "./config";
import { BASE_AGENT_INSTRUCTIONS } from "./system-prompt";
import { truncateText } from "./redaction";
import type { Chat, ChatAttachment, ChatMessage, MemoryItem, Preset, UserPreferences } from "@/lib/types/workspace";
import type { Project } from "@/lib/types/database";
import type { AgentContentPart, AgentMessage } from "./types";
import { getCategoryFromMime } from "@/lib/attachments/mime";
import { getModelById } from "@/lib/models/registry";

export interface ContextSources {
  chat: Chat;
  project: Project | null;
  preset: Preset | null;
  preferences: UserPreferences | null;
  memory: MemoryItem[];
  knowledgeNotes: string[];
  recentMessages: ChatMessage[];
  attachments: ChatAttachment[];
  currentMessage: ChatMessage;
  modelId: string;
}

export interface AssembledContext {
  systemPrompt: string;
  history: AgentMessage[];
  currentUserMessage: AgentMessage;
  visionImageUrls: string[];
}

function section(title: string, body: string | null | undefined, max: number): string {
  if (!body?.trim()) return "";
  return `\n\n## ${title}\n${truncateText(body.trim(), max)}`;
}

export function modelSupportsVision(modelId: string): boolean {
  const model = getModelById(modelId);
  if (model?.capabilities.vision) return true;
  return /gpt-4o|gemini|claude|vision/i.test(modelId);
}

export function assembleSystemPrompt(sources: ContextSources): string {
  const personalization = sources.preferences?.personalization;
  const presetSettings = sources.preset?.settings ?? {};
  const parts = [
    BASE_AGENT_INSTRUCTIONS,
    section(
      "Chat preset",
      [
        sources.preset?.name ? `Preset: ${sources.preset.name}` : "",
        typeof presetSettings.systemPrompt === "string" ? presetSettings.systemPrompt : "",
        typeof presetSettings.model === "string" ? `Preferred model: ${presetSettings.model}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      3000,
    ),
    section(
      "Personalization",
      [
        personalization?.aboutMe ? `About user: ${personalization.aboutMe}` : "",
        personalization?.communicationStyle ? `Style: ${personalization.communicationStyle}` : "",
        personalization?.globalInstructions ? personalization.globalInstructions : "",
        personalization?.preferredLanguage ? `Language: ${personalization.preferredLanguage}` : "",
        personalization?.agentBehavior ? personalization.agentBehavior : "",
      ]
        .filter(Boolean)
        .join("\n"),
      CONTEXT_BUDGET.maxPersonalizationChars,
    ),
    section(
      "Global and project memory",
      sources.memory
        .map((item) => `- [${item.scope}${item.pinned ? ", pinned" : ""}] ${item.content}`)
        .join("\n"),
      CONTEXT_BUDGET.maxMemoryChars,
    ),
    section(
      "Project",
      sources.project
        ? [
            `Name: ${sources.project.name}`,
            sources.project.description ? `Description: ${sources.project.description}` : "",
            sources.project.system_prompt ? `Instructions:\n${sources.project.system_prompt}` : "",
            `Language: ${sources.project.default_language}`,
            sources.project.target_platforms?.length
              ? `Platforms: ${sources.project.target_platforms.join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n")
        : "This chat is not inside a project. project_id is null. Do not invent a project.",
      CONTEXT_BUDGET.maxProjectInstructionsChars,
    ),
    section(
      "Relevant knowledge (partial retrieval — use search_knowledge for more)",
      sources.knowledgeNotes.join("\n\n"),
      CONTEXT_BUDGET.maxKnowledgeChars,
    ),
    section("Chat summary", sources.chat.summary, CONTEXT_BUDGET.maxSummaryChars),
  ];

  return truncateText(parts.join(""), CONTEXT_BUDGET.maxSystemPromptChars);
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

export function assembleContext(sources: ContextSources): AssembledContext {
  const current = buildCurrentUserMessage(sources.currentMessage, sources.attachments, sources.modelId);
  const prior = sources.recentMessages.filter((message) => message.id !== sources.currentMessage.id);
  return {
    systemPrompt: assembleSystemPrompt(sources),
    history: historyToAgentMessages(prior),
    currentUserMessage: current.message,
    visionImageUrls: current.visionImageUrls,
  };
}
