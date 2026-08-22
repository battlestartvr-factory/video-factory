import type { AgentToolDefinition } from "@/lib/agent/types";
import { getToolDefinitions } from "./index";

/** Hard cap on tools sent to a provider in one request. */
export const MAX_TOOLS_PER_REQUEST = 6;

/** Target range for tool selection (soft guidance). */
export const TARGET_TOOLS_PER_REQUEST = 4;

export type TurnIntent =
  | "general"
  | "game_discovery"
  | "knowledge"
  | "image"
  | "video"
  | "memory"
  | "projects"
  | "web";

/** Explicit tool groups — never send the full registry. */
export const TOOL_GROUPS: Record<Exclude<TurnIntent, "general">, readonly string[]> = {
  game_discovery: ["start_game_discovery"],
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

const GAME_DISCOVERY_PATTERNS: RegExp[] = [
  /discovery\s+pipeline/i,
  /stage\s*4.*(?:discovery|co-?op|game)/i,
  /(?:повтор|перезапуст|запуст).*(?:поиск|discovery).*(?:co-?op|кооп|игр|game)/i,
  /(?:поиск|найд[иь]|придумай|предложи).*(?:нов(?:ую|ые)\s+)?(?:pc\/?steam|steam).*(?:co-?op|кооп|игр)/i,
  /(?:нов(?:ую|ые|ой)|перспективн(?:ую|ые|ой)).*(?:co-?op|кооп).*(?:игр|game)/i,
  /gameplay\s+reference\s+images?/i,
  /reference\s+(?:image|изображ).*(?:approve|revise|reject|утверд)/i,
  /(?:concept|концепт).*(?:diversity|pre-?evaluation|gameplay\s+moment)/i,
];

const GAME_DOMAIN_PATTERN = /(?:\bигр(?:а|ы|у|ой|е|ам|ами|ах|ок|ушка|ушку)?\b|\bgame(?:s|play)?\b|\bгеймпле(?:й|я|ем)?\b|\bко-?оп\b|\bco-?op\b|\bcoop\b|\bfps\b|\bsteam\b)/iu;
const GAME_DESIGN_ACTION_PATTERN = /(?:придум\p{L}*|предлож\p{L}*|улучш\p{L}*|усил\p{L}*|доработ\p{L}*|передел\p{L}*|измен\p{L}*|разработ\p{L}*|проработ\p{L}*|оцен\p{L}*|поиграй\s+с|что\s+думаешь|как\s+тебе|питч\p{L}*|pitch\w*|design\w*|improv\w*|rework\w*|iterate\w*|invent\w*|brainstorm\w*)/iu;
const GAME_CONCEPT_OWNERSHIP_PATTERN = /(?:я\s+придумал\p{L}*|моя\s+(?:игра|идея|концепц\p{L}*)|мой\s+концепт|у\s+меня\s+(?:есть\s+)?(?:игра|идея|концепт)|вот\s+(?:моя\s+)?(?:идея|концепт))/iu;
const GAME_DESIGN_SUBJECT_PATTERN = /(?:механик\p{L}*|концепц\p{L}*|концепт\p{L}*|core\s+loop|game\s+design|геймдизайн\p{L}*)/iu;
const NON_DISCOVERY_CREATIVE_PATTERN = /(?:реклам\p{L}*|маркетинг\p{L}*|слоган\p{L}*|копирайт\p{L}*|пост\s+(?:для|в)|store\s+description|описани\p{L}*\s+(?:для\s+)?(?:steam|магазин)|трейлер\p{L}*\s+(?:текст|сценар))/iu;

/**
 * Product-level admission for the simplified Game Discovery Factory.
 * Users should be able to talk about a new or existing game exactly as they would in ChatGPT;
 * they must not know internal keywords such as "Stage 4" or "Discovery".
 */
export function isNaturalGameDesignRequest(text: string): boolean {
  const normalized = text.trim();
  if (!normalized || !GAME_DOMAIN_PATTERN.test(normalized)) return false;

  const asksForDesignWork = GAME_DESIGN_ACTION_PATTERN.test(normalized);
  const isOwnedConceptDiscussion =
    GAME_CONCEPT_OWNERSHIP_PATTERN.test(normalized) && GAME_DESIGN_SUBJECT_PATTERN.test(normalized);

  if (!asksForDesignWork && !isOwnedConceptDiscussion) return false;

  // Keep obvious marketing/copy requests in normal chat unless the same turn explicitly asks
  // to change the game design itself.
  if (NON_DISCOVERY_CREATIVE_PATTERN.test(normalized) && !GAME_DESIGN_SUBJECT_PATTERN.test(normalized)) {
    return false;
  }

  return true;
}

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

  // Discovery admission is checked before generic creativity/image/video because normal game
  // briefs frequently contain words like "idea", "video" and "image" while still asking the
  // factory to invent or improve the game itself.
  if (isNaturalGameDesignRequest(text) || matchesAny(text, GAME_DISCOVERY_PATTERNS)) return "game_discovery";
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
    if (isNaturalGameDesignRequest(text) || matchesAny(text, GAME_DISCOVERY_PATTERNS)) return "game_discovery";
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
