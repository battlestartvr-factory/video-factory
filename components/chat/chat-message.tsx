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
  const meta = message.metadata as MessageMetadata;

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
          {meta.type === "task" && meta.task ? (
            <>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
              <TaskCard task={meta.task} />
            </>
          ) : meta.type === "generation" && meta.generation ? (
            <GenerationCard generation={meta.generation} />
          ) : meta.type === "error" && meta.error ? (
            <ErrorCard error={meta.error} onRetry={onRetry} />
          ) : meta.type === "sources" && meta.sources ? (
            <>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
              <SourcesCard sources={meta.sources} />
            </>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          )}
        </div>
      </div>
    </div>
  );
}
