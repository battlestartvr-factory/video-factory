import type { AgentToolDefinition, AnyAgentTool } from "@/lib/agent/types";
import { zodToFunctionParameters } from "@/lib/agent/schemas";
import { answerUserTool } from "./answer-user";
import { generateImageTool } from "./generate-image";
import { generateVideoTool } from "./generate-video";
import { addToKnowledgeTool, listKnowledgeDocumentsTool, searchKnowledgeTool } from "./knowledge";
import { saveMemoryTool, searchMemoryTool, updateMemoryTool } from "./memory";
import {
  createProjectTool,
  getProjectContextTool,
  listProjectFilesTool,
  updateProjectInstructionsTool,
} from "./projects";
import { extractDocumentTool, inspectAttachmentTool } from "./files";
import { webFetchTool, webSearchTool } from "./web";

const TOOLS: AnyAgentTool[] = [
  answerUserTool,
  generateImageTool,
  generateVideoTool,
  searchKnowledgeTool,
  addToKnowledgeTool,
  listKnowledgeDocumentsTool,
  searchMemoryTool,
  saveMemoryTool,
  updateMemoryTool,
  getProjectContextTool,
  listProjectFilesTool,
  createProjectTool,
  updateProjectInstructionsTool,
  inspectAttachmentTool,
  extractDocumentTool,
  webSearchTool,
  webFetchTool,
] as unknown as AnyAgentTool[];

const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function getRegisteredTools(): AnyAgentTool[] {
  return TOOLS;
}

export function getToolByName(name: string): AnyAgentTool | undefined {
  return TOOL_MAP.get(name);
}

export function getToolDefinitions(): AgentToolDefinition[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: zodToFunctionParameters(tool.inputSchema),
  }));
}

export function listToolNames(): string[] {
  return TOOLS.map((tool) => tool.name);
}

export {
  resolveToolsForTurn,
  detectTurnIntent,
  TOOL_GROUPS,
  MAX_TOOLS_PER_REQUEST,
  TARGET_TOOLS_PER_REQUEST,
  type TurnIntent,
  type ResolveToolsForTurnInput,
  type ResolveToolsForTurnResult,
} from "./resolve-tools-for-turn";
