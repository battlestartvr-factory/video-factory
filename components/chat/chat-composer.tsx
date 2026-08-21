"use client";

import { useState, useRef, useCallback } from "react";
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isHero = variant === "hero";
  const effectiveDisabled = disabled || submitting;
  const inputDisabled = effectiveDisabled || stopActive;

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
    if (effectiveDisabled || stopActive || (!trimmed && files.length === 0)) return;

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
            placeholder={stopActive ? "Процесс выполняется — нажмите Stop, чтобы остановить" : isHero ? "Спросите что угодно" : "Напишите сообщение…"}
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
            {stopActive ? (
              <Button
                type="button"
                size="icon"
                className={cn("shrink-0 rounded-full", isHero ? "h-9 w-9" : "h-8 w-8")}
                disabled={stopPending || !onStop}
                onClick={() => void onStop?.()}
                aria-label="Остановить"
                title="Остановить текущий процесс"
              >
                {stopPending ? (
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
