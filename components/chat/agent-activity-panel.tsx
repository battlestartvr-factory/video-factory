"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentUiEvent } from "@/lib/types/workspace";

interface AgentActivityPanelProps {
  events: AgentUiEvent[];
  isActive?: boolean;
  className?: string;
}

function isCompleted(event: AgentUiEvent): boolean {
  return (
    event.status === "completed" ||
    event.type.includes("completed") ||
    event.type === "final" ||
    event.type === "finalizing" ||
    (event.label?.startsWith("✓") ?? false)
  );
}

function isFailed(event: AgentUiEvent): boolean {
  return event.status === "failed" || event.type.includes("failed") || (event.label?.startsWith("✕") ?? false);
}

export function AgentActivityPanel({ events, isActive = false, className }: AgentActivityPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const displayEvents = useMemo(
    () =>
      events.filter(
        (event) =>
          event.label &&
          !["run_started", "context_started"].includes(event.type),
      ),
    [events],
  );

  if (!displayEvents.length && !isActive) return null;

  const currentLabel =
    (isActive
      ? displayEvents.find((e) => !isCompleted(e) && !isFailed(e))?.label
      : null) ?? (isActive ? "● Думаю…" : null);

  const completedCount = displayEvents.filter(isCompleted).length;

  return (
    <div className={cn("mt-2 rounded-lg border border-border-subtle bg-surface/60 px-3 py-2 text-xs", className)}>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="flex items-center gap-2 text-muted-foreground">
          {isActive ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
          ) : null}
          <span className={cn(isActive && "animate-pulse text-foreground")}>
            {currentLabel ?? `${completedCount || displayEvents.length} действий`}
          </span>
        </span>
        {displayEvents.length > 0 ? (
          expanded ? (
            <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )
        ) : null}
      </button>

      {expanded && displayEvents.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t border-border-subtle pt-2">
          {displayEvents.map((event, index) => (
            <li
              key={`${event.type}-${event.toolName ?? ""}-${index}`}
              className={cn(
                "text-muted-foreground",
                isFailed(event) && "text-destructive",
                isCompleted(event) && "text-foreground/80",
              )}
            >
              {event.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
