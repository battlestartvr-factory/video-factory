import type { AgentToolDefinition } from "@/lib/agent/types";
import { getToolDefinitions } from "./index";

/** Hard cap on tools sent to a provider in one request. */
export const MAX_TOOLS_PER_REQUEST = 6;

/** Target range for tool selection (soft guidance). */
export const TARGET_TOOLS_PER_REQUEST = 4;

export type TurnIntent =
  | "general"
  | "knowledge"
  | "image"
  | "video"
  | "memory"
  | "projects"
  | "web";

/** Explicit tool groups — never send the full registry. */
export const TOOL_GROUPS: Record<Exclude<TurnIntent, "general">, readonly string[]> = {
  knowledge: [
    "search_knowledge",
    "list_knowledge_documents",
    "extract_document",
    "inspect_attachment",
  ],
  image: ["generate_image", "inspect_attachment"],
  video: ["generate_video", "inspect_attachment"],
  memory: [
    "search_memory",
    "save_memory",
    "update_memory",
    "inspect_attachment",
    "extract_document",
  ],
  projects: [
    "get_project_context",
    "list_project_files",
    "create_project",
    "update_project_instructions",
  ],
  web: ["web_search", "web_fetch"],
} as const;

const ALL_DEFINITIONS = () => getToolDefinitions();

const GENERAL_PATTERNS: RegExp[] = [
  /^(?:привет|здравствуй|hello|hi|hey|добрый\s+(?:день|утро|вечер))(?:[!?.…,\s]|$)/i,
  /^(?:как\s+дела|как\s+ты)(?:[!?.…,\s]|$)/i,
  /что\s+ты\s+умеешь/i,
  /^объясни(?:\s|$)/i,
  /^расскажи(?:\s|$)(?!.*(?:баз[ae]\s+знан|knowledge|документ|pdf|урок))/i,
  /напиши\s+(?:текст|стих|письмо|эссе|рассказ)/i,
  /придумай\s+(?:идеи|идею)/i,
  /^спасибо(?:[!?.…,\s]|$)/i,
  /^thanks(?:[!?.…,\s]|$)/i,
];

const KNOWLEDGE_PATTERNS: RegExp[] = [
  /баз[ae]\s+знан/i,
  /knowledge\s+base/i,
  /найди\s+в\s+баз/i,
  /из\s+баз[ae]\s+знан/i,
  /что\s+сказано\s+в/i,
  /изучи\s+документ/i,
  /(?:найди|ищи|поиск).*(?:документ|pdf|файл)/i,
  /урок\s+[\d«"']/i,
  /«[^»]+».*(?:баз[ae]\s+знан|knowledge)/i,
  /(?:баз[ae]\s+знан|knowledge).*(?:урок|документ|pdf)/i,
  /add_to_knowledge|добав(?:ь|ить)\s+в\s+баз/i,
];

const IMAGE_PATTERNS: RegExp[] = [
  /generate_image|сгенерир.*(?:изображ|картин|image)/i,
  /(?:нарисуй|создай|сгенерир).*(?:картин|изображ|image|иллюстрац)/i,
  /(?:картин|изображени|image|illustration).*(?:сгенерир|создай|нарисуй)/i,
];

const VIDEO_PATTERNS: RegExp[] = [
  /generate_video|сгенерир.*(?:видео|ролик|video)/i,
  /(?:создай|сгенерир|сделай).*(?:видео|ролик|video|клип)/i,
  /(?:видео|ролик|video).*(?:сгенерир|создай)/i,
];

const MEMORY_PATTERNS: RegExp[] = [
  /(?:search_memory|save_memory|update_memory)/i,
  /(?:запомни|remember|сохрани\s+в\s+памят|добав.*в\s+памят)/i,
  /(?:научись|learn).*(?:из|from).*(?:документ|файл|research|report)/i,
  /(?:инсайт|вывод|срез\s+рынка|market\s+(?:snapshot|report)).*(?:памят|запом|learn)/i,
  /(?:найди|ищи|search).*(?:памят|memory)/i,
  /(?:моя\s+)?память/i,
  /что\s+(?:ты\s+)?(?:знаешь|помнишь)\s+обо\s+мне/i,
];

const PROJECT_PATTERNS: RegExp[] = [
  /(?:project|проект)/i,
  /get_project_context|list_project_files|create_project|update_project_instructions/i,
  /(?:файлы|files)\s+проект/i,
  /инструкци.*проект/i,
  /создай\s+проект/i,
];

const WEB_PATTERNS: RegExp[] = [
  /web_search|web_fetch/i,
  /(?:найди|ищи|search).*(?:интернет|web|online|в\s+сети)/i,
  /(?:интернет|web|online|в\s+сети).*(?:найди|ищи|search)/i,
  /(?:загрузи|fetch|прочитай)\s+(?:страниц|url|сайт|ссылк)/i,
];

export interface ResolveToolsForTurnInput {
  userMessage: string;
  attachmentIds?: string[];
  projectId?: string | null;
  /** @deprecated Presets are retired and this value is ignored. */
  presetId?: string | null;
  /** @deprecated Presets are retired and this value is ignored. */
  presetType?: string | null;
}

export interface ResolveToolsForTurnResult {
  intent: TurnIntent;
  tools: AgentToolDefinition[];
  toolNames: string[];
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function detectTurnIntent(input: ResolveToolsForTurnInput): TurnIntent {
  const text = input.userMessage.trim();
  if (!text) return "general";

  if (matchesAny(text, MEMORY_PATTERNS)) return "memory";
  if (matchesAny(text, WEB_PATTERNS)) return "web";
  if (matchesAny(text, KNOWLEDGE_PATTERNS)) return "knowledge";
  if (matchesAny(text, IMAGE_PATTERNS)) return "image";
  if (matchesAny(text, VIDEO_PATTERNS)) return "video";

  if (matchesAny(text, PROJECT_PATTERNS) || (input.projectId && /файл|file|контекст|context/i.test(text))) {
    return "projects";
  }

  const hasAttachments = (input.attachmentIds?.length ?? 0) > 0;
  if (hasAttachments) {
    if (matchesAny(text, IMAGE_PATTERNS)) return "image";
    if (matchesAny(text, VIDEO_PATTERNS)) return "video";
    if (/pdf|документ|document|extract|извлеч|research|report|срез\s+рынка/i.test(text)) return "knowledge";
  }

  if (matchesAny(text, GENERAL_PATTERNS)) return "general";

  return "general";
}

function toolNamesForIntent(intent: TurnIntent, input: ResolveToolsForTurnInput): string[] {
  if (intent === "general") return [];

  let names = [...TOOL_GROUPS[intent]];

  if (intent === "knowledge" && /добав(?:ь|ить)\s+в\s+баз|add.*knowledge/i.test(input.userMessage)) {
    names = [...names, "add_to_knowledge"];
  }

  const unique = [...new Set(names)];
  return unique.slice(0, MAX_TOOLS_PER_REQUEST);
}

function definitionsByNames(names: string[]): AgentToolDefinition[] {
  if (names.length === 0) return [];
  const registry = ALL_DEFINITIONS();
  const byName = new Map(registry.map((tool) => [tool.name, tool]));
  return names
    .map((name) => byName.get(name))
    .filter((tool): tool is AgentToolDefinition => tool != null);
}

/** Provider-neutral tool selection for a single user turn. */
export function resolveToolsForTurn(input: ResolveToolsForTurnInput): ResolveToolsForTurnResult {
  const intent = detectTurnIntent(input);
  const toolNames = toolNamesForIntent(intent, input);
  const tools = definitionsByNames(toolNames);

  return {
    intent,
    tools,
    toolNames: tools.map((tool) => tool.name),
  };
}
