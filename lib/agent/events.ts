import type { AgentEvent, AgentEventType } from "./types";

const TOOL_LABELS: Record<string, string> = {
  web_search: "Ищу актуальную информацию…",
  web_fetch: "Читаю источник…",
  search_knowledge: "Ищу в базе знаний…",
  add_to_knowledge: "Добавляю в базу знаний…",
  list_knowledge_documents: "Смотрю документы базы знаний…",
  search_memory: "Ищу в памяти…",
  save_memory: "Сохраняю в память…",
  update_memory: "Обновляю память…",
  inspect_attachment: "Смотрю вложение…",
  extract_document: "Читаю документ…",
  generate_image: "Создаю изображение…",
  generate_video: "Создаю видео…",
  get_project_context: "Собираю контекст…",
  list_project_files: "Смотрю файлы проекта…",
  create_project: "Создаю проект…",
  update_project_instructions: "Обновляю инструкции проекта…",
  answer_user: "Формирую ответ…",
};

export const CONTEXT_LABELS = {
  started: "Собираю контекст…",
  completed: "✓ Собрал контекст",
  memory: "✓ Проверил память",
  finalizing: "Формирую ответ…",
  thinking: "● Думаю…",
} as const;

export function toolEventLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? `Выполняю ${toolName}…`;
}

export function createAgentEvent(
  type: AgentEventType,
  extra: Omit<AgentEvent, "type" | "at"> = {},
): AgentEvent {
  return {
    type,
    ...extra,
    label: extra.label ?? (extra.toolName ? toolEventLabel(extra.toolName) : undefined),
    at: new Date().toISOString(),
  };
}
