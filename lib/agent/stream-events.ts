import type { AgentEvent } from "./types";
import type { StreamEvent, StreamEventType } from "./stream-events.types";
export type { StreamEvent, StreamEventType } from "./stream-events.types";
export { encodeSseEvent } from "./stream-events.types";

export type StreamEventEmitter = (event: StreamEvent) => void;

const TOOL_COMPLETED_SUMMARY: Record<string, (output?: Record<string, unknown>) => string> = {
  search_knowledge: (output) => {
    const hits = Array.isArray(output?.hits) ? output!.hits.length : 0;
    const docs = new Set(
      (Array.isArray(output?.hits) ? output!.hits : []).map(
        (h: { documentId?: string; document_id?: string }) => h.documentId ?? h.document_id,
      ),
    ).size;
    return hits ? `✓ Найдено ${hits} фрагментов в ${docs || 1} документах` : "✓ База знаний проверена";
  },
  web_search: (output) => {
    const count = Array.isArray(output?.results) ? output!.results.length : 0;
    return count ? `✓ Проверено ${count} источников` : "✓ Поиск завершён";
  },
  search_memory: () => "✓ Память проверена",
  get_project_context: () => "✓ Собрал контекст",
  list_project_files: () => "✓ Файлы проекта просмотрены",
};

export function toolCompletedSummary(toolName: string, output?: Record<string, unknown>): string {
  const builder = TOOL_COMPLETED_SUMMARY[toolName];
  return builder ? builder(output) : `✓ ${toolName} выполнен`;
}

export function streamEvent(type: StreamEventType, extra: Omit<StreamEvent, "type" | "at"> = {}): StreamEvent {
  return { type, at: new Date().toISOString(), ...extra };
}

export function agentEventToUi(event: AgentEvent): {
  type: string;
  toolName?: string;
  label?: string;
  status?: string;
} {
  return {
    type: event.type,
    toolName: event.toolName,
    label: event.label,
    status: event.status,
  };
}
