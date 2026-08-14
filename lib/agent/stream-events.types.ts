/** Client-safe SSE event types for chat activity streaming */

export type StreamEventType =
  | "message.accepted"
  | "agent.run.started"
  | "context.started"
  | "context.completed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "generation.queued"
  | "agent.finalizing"
  | "assistant.message"
  | "turn.completed"
  | "agent.run.completed"
  | "agent.run.failed";

export interface StreamEvent {
  type: StreamEventType;
  at: string;
  label?: string;
  toolName?: string;
  status?: string;
  summary?: string;
  errorCode?: string;
  content?: string;
  agentRunId?: string;
}

export function encodeSseEvent(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
