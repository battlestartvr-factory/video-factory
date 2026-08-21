"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { ArrowUp, Loader2, Paperclip, Plus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getAcceptString } from "@/lib/attachments/mime";
import { DEFAULT_LLM_MODEL } from "@/lib/agent/config";
import { ContextInspector } from "./context-inspector";

interface PendingFile {
  id: string;
  file: File;
  preview?: string;
}

interface ChatComposerProps {
  onSend: (
    content: string,
    options: { modelId?: string; reasoningLevel?: string; files: File[] },
  ) => Promise<boolean> | boolean;
  onStop?: () => Promise<void> | void;
  stopActive?: boolean;
  stopPending?: boolean;
  disabled?: boolean;
  chatId?: string;
  defaultModelId?: string;
  defaultReasoningLevel?: string;
  variant?: "default" | "hero";
  autoFocus?: boolean;
}

const TERMINAL_FACTORY_STATUSES = new Set(["completed", "failed", "cancelled"]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function latestDiscoveryV2RunId(payload: unknown): string | null {
  const data = object(object(payload).data);
  const messages = array(data.messages);
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = object(messages[messageIndex]);
    if (message.role !== "assistant") continue;
    const metadata = object(message.metadata);
    const tasks = array(metadata.tasks).length ? array(metadata.tasks) : metadata.task ? [metadata.task] : [];
    for (let taskIndex = tasks.length - 1; taskIndex >= 0; taskIndex -= 1) {
      const task = object(tasks[taskIndex]);
      if (task.action !== "game_discovery") continue;
      const settings = object(task.settings);
      if (Number(settings.workflowVersion ?? 1) !== 2) continue;
      return typeof settings.runId === "string" && settings.runId ? settings.runId : null;
    }
  }
  return null;
}

export function ChatComposer({
  onSend,
  onStop,
  stopActive = false,
  stopPending = false,
  disabled,
  chatId,
  defaultModelId = DEFAULT_LLM_MODEL,
  variant = "default",
  autoFocus = false,
}: ChatComposerProps) {
  const [content, setContent] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [autoStopTarget, setAutoStopTarget] = useState<{ chatId: string; runId: string } | null>(null);
  const [autoStopPending, setAutoStopPending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isHero = variant === "hero";
  const autoStopRunId = autoStopTarget && autoStopTarget.chatId === chatId ? autoStopTarget.runId : null;
  const effectiveStopActive = stopActive || Boolean(autoStopRunId);
  const effectiveStopPending = stopPending || autoStopPending;
  const effectiveDisabled = disabled || submitting;
  const inputDisabled = effectiveDisabled || effectiveStopActive;

  useEffect(() => {
    if (!chatId || stopActive) return;

    let cancelled = false;
    let source: EventSource | null = null;
    let attachedRunId: string | null = null;

    const detach = () => {
      source?.close();
      source = null;
      attachedRunId = null;
    };

    const markInactive = (runId: string) => {
      setAutoStopTarget((current) => current?.runId === runId ? null : current);
      if (attachedRunId === runId) detach();
    };

    const attach = (runId: string) => {
      if (cancelled || attachedRunId === runId) return;
      detach();
      attachedRunId = runId;
      setAutoStopTarget({ chatId, runId });
      source = new EventSource(`/api/discovery/batches/${runId}/trace`);
      source.addEventListener("trace", ((message: MessageEvent<string>) => {
        try {
          const payload = object(JSON.parse(message.data));
          if (payload.eventType === "job.cancelled") markInactive(runId);
        } catch {
          // A malformed trace frame must not disable a valid Stop button.
        }
      }) as EventListener);
      source.addEventListener("done", () => markInactive(runId));
    };

    const inspectOnce = async () => {
      const messagesResponse = await fetch(`/api/chats/${chatId}/messages?limit=50`, { cache: "no-store" });
      if (!messagesResponse.ok || cancelled) return;
      const messagesPayload = await messagesResponse.json().catch(() => null);
      const runId = latestDiscoveryV2RunId(messagesPayload);
      if (!runId || cancelled) return;

      const batchResponse = await fetch(`/api/discovery/batches/${runId}`, { cache: "no-store" });
      if (!batchResponse.ok || cancelled) return;
      const batchPayload = await batchResponse.json().catch(() => null);
      const status = object(object(object(batchPayload).data).factoryJob).status;
      if (typeof status === "string" && !TERMINAL_FACTORY_STATUSES.has(status)) attach(runId);
    };

    const onActivity = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = object(event.detail);
      const runId = typeof detail.runId === "string" ? detail.runId : null;
      if (!runId) return;
      if (detail.active === true) attach(runId);
      else if (detail.active === false) markInactive(runId);
    };

    window.addEventListener("game-discovery-v2-activity", onActivity);
    void inspectOnce();
    return () => {
      cancelled = true;
      window.removeEventListener("game-discovery-v2-activity", onActivity);
      detach();
    };
  }, [chatId, stopActive]);

  const addFiles = useCallback((newFiles: FileList | File[]) => {
    const arr = Array.from(newFiles);
    setFiles((prev) => [
      ...prev,
      ...arr.map((file) => ({
        id: crypto.randomUUID(),
        file,
        preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      })),
    ]);
  }, []);

  const handleSend = async () => {
    const trimmed = content.trim();
    if (effectiveDisabled || effectiveStopActive || (!trimmed && files.length === 0)) return;

    setSubmitting(true);
    try {
      const sent = await onSend(trimmed, {
        files: files.map((f) => f.file),
      });
      if (!sent) return;

      for (const pending of files) {
        if (pending.preview) URL.revokeObjectURL(pending.preview);
      }
      setContent("");
      setFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } finally {
      setSubmitting(false);
    }
  };

  const handleStop = async () => {
    if (effectiveStopPending) return;
    if (onStop && stopActive) {
      await onStop();
      return;
    }
    if (!autoStopRunId) return;

    setAutoStopPending(true);
    try {
      const response = await fetch(`/api/discovery/batches/${autoStopRunId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "chat_stop_button" }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) return;
      const stoppedRunId = autoStopRunId;
      setAutoStopTarget(null);
      window.dispatchEvent(new CustomEvent("game-discovery-v2-activity", {
        detail: { runId: stoppedRunId, active: false },
      }));
    } finally {
      setAutoStopPending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, isHero ? 240 : 200)}px`;
  };

  return (
    <div
      className={cn(
        isHero ? "w-full" : "border-t border-border bg-surface/80 backdrop-blur-sm",
      )}
    >
      <div className={cn("mx-auto max-w-3xl px-4", isHero ? "py-0" : "py-3")}>
        {files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {files.map((f) => (
              <div
                key={f.id}
                className="flex items-center gap-2 rounded-lg border border-border bg-surface-elevated px-2 py-1 text-xs"
              >
                {f.preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.preview} alt="" className="h-6 w-6 rounded object-cover" />
                ) : null}
                <span className="max-w-[120px] truncate">{f.file.name}</span>
                <button
                  type="button"
                  onClick={() => setFiles((prev) => prev.filter((x) => x.id !== f.id))}
                  className="text-muted-foreground hover:text-foreground"
                  disabled={inputDisabled}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div
          className={cn(
            "border border-border bg-surface-elevated transition-colors",
            isHero
              ? "rounded-[1.75rem] shadow-lg shadow-black/20"
              : "rounded-xl shadow-md",
            dragOver && "drag-over",
          )}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (!inputDisabled && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
          }}
        >
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={effectiveStopActive ? "Процесс выполняется — нажмите Stop, чтобы остановить" : isHero ? "Спросите что угодно" : "Напишите сообщение…"}
            rows={isHero ? 2 : 1}
            autoFocus={autoFocus}
            disabled={inputDisabled}
            className={cn(
              "chat-composer-textarea w-full resize-none bg-transparent text-foreground placeholder:text-muted focus:outline-none focus-visible:outline-none focus-visible:ring-0",
              isHero
                ? "min-h-[88px] px-5 pt-5 pb-2 text-base leading-6"
                : "px-4 pt-3 pb-1 text-sm",
            )}
          />
          <div
            className={cn(
              "flex items-end justify-between gap-2",
              isHero ? "px-3 pb-3" : "px-2 pb-2",
            )}
          >
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn("shrink-0", isHero ? "h-9 w-9 rounded-full" : "h-8 w-8")}
                onClick={() => fileInputRef.current?.click()}
                aria-label="Добавить файл"
                disabled={inputDisabled}
              >
                {isHero ? <Plus className="h-5 w-5" /> : <Paperclip className="h-4 w-4" />}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={getAcceptString()}
                className="hidden"
                onChange={(e) => e.target.files && addFiles(e.target.files)}
                disabled={inputDisabled}
              />
              {chatId ? (
                <ContextInspector
                  chatId={chatId}
                  modelId={defaultModelId}
                  draftContent={content}
                />
              ) : null}
            </div>
            {effectiveStopActive ? (
              <Button
                type="button"
                size="icon"
                className={cn("shrink-0 rounded-full", isHero ? "h-9 w-9" : "h-8 w-8")}
                disabled={effectiveStopPending || (!onStop && !autoStopRunId)}
                onClick={() => void handleStop()}
                aria-label="Остановить"
                title="Остановить текущий процесс"
              >
                {effectiveStopPending ? (
                  <Loader2 className={cn("animate-spin", isHero ? "h-5 w-5" : "h-4 w-4")} />
                ) : (
                  <Square className={cn("fill-current", isHero ? "h-4 w-4" : "h-3.5 w-3.5")} />
                )}
              </Button>
            ) : (
              <Button
                size="icon"
                className={cn("shrink-0 rounded-full", isHero ? "h-9 w-9" : "h-8 w-8")}
                disabled={effectiveDisabled || (!content.trim() && files.length === 0)}
                onClick={() => void handleSend()}
                aria-label="Отправить"
              >
                <ArrowUp className={isHero ? "h-5 w-5" : "h-4 w-4"} />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
