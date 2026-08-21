export interface ResearchScoutProgressEvent {
  eventType:
    | "research.scout.started"
    | "research.search.started"
    | "research.search.completed"
    | "research.source.fetch_started"
    | "research.source.accepted"
    | "research.source.rejected"
    | "research.source_pool.reused"
    | "research.evidence.extracted"
    | "research.scout.execution_completed";
  key: string;
  payload?: Record<string, unknown>;
}

export type ResearchScoutProgressReporter = (
  event: ResearchScoutProgressEvent,
) => Promise<void>;
