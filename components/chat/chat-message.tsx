"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import type { ChatMessage, MessageMetadata } from "@/lib/types/workspace";
import { TaskCard } from "./task-card";
import { GenerationCard } from "./generation-card";
import { ErrorCard } from "./error-card";
import { SourcesCard } from "./sources-card";
import { User, Bot } from "lucide-react";

interface ChatMessageProps {
  message: ChatMessage;
  onRetry?: () => void;
}

export function ChatMessageView({ message, onRetry }: ChatMessageProps) {
  const isUser = message.role === "user";
  const meta = (message.metadata ?? {}) as MessageMetadata;
  const generations = meta.generations?.length
    ? meta.generations
    : meta.generation
      ? [meta.generation]
      : [];
  const tasks = meta.tasks?.length ? meta.tasks : meta.task ? [meta.task] : [];

  return (
    <div
      className={cn(
        "group flex gap-3 px-4 py-4",
        isUser ? "bg-transparent" : "bg-surface/50",
      )}
    >
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
          isUser ? "bg-accent-muted text-accent" : "bg-surface-elevated text-muted-foreground",
        )}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="prose-chat text-sm text-foreground">
          {message.content ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          ) : null}
          {tasks.map((task, index) => (
            <TaskCard key={`${task.action}-${index}`} task={task} />
          ))}
          {generations.map((generation) => (
            <GenerationCard key={generation.generationId} generation={generation} />
          ))}
          {meta.sources?.length ? <SourcesCard sources={meta.sources} /> : null}
          {meta.error ? <ErrorCard error={meta.error} onRetry={onRetry} /> : null}
        </div>
      </div>
    </div>
  );
}
