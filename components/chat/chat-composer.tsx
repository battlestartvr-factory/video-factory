"use client";

import { useState, useRef, useCallback } from "react";
import { ArrowUp, Paperclip, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getAcceptString } from "@/lib/attachments/mime";
import { DEFAULT_LLM_MODEL, DEFAULT_REASONING_LEVEL } from "@/lib/agent/config";
import { ModelSelector } from "./model-selector";
import { ReasoningSelector } from "./reasoning-selector";
import { PresetSelector } from "./preset-selector";
import { ContextInspector } from "./context-inspector";
import type { Preset } from "@/lib/types/workspace";

interface PendingFile {
  id: string;
  file: File;
  preview?: string;
}

interface ChatComposerProps {
  onSend: (content: string, options: { modelId?: string; reasoningLevel?: string; presetId?: string; files: File[] }) => void;
  disabled?: boolean;
  presets?: Preset[];
  chatId?: string;
  defaultModelId?: string;
  defaultReasoningLevel?: string;
  defaultPresetId?: string;
  variant?: "default" | "hero";
  autoFocus?: boolean;
}

export function ChatComposer({
  onSend,
  disabled,
  presets = [],
  chatId,
  defaultModelId = DEFAULT_LLM_MODEL,
  defaultReasoningLevel = DEFAULT_REASONING_LEVEL,
  defaultPresetId,
  variant = "default",
  autoFocus = false,
}: ChatComposerProps) {
  const [content, setContent] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [modelId, setModelId] = useState(defaultModelId);
  const [reasoningLevel, setReasoningLevel] = useState(defaultReasoningLevel);
  const [presetId, setPresetId] = useState(defaultPresetId ?? "00000000-0000-4000-8000-000000000001");
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isHero = variant === "hero";

  const persistChatSettings = useCallback(
    async (updates: { modelId?: string; reasoningLevel?: string }) => {
      if (!chatId) return;
      await fetch(`/api/chats/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
    },
    [chatId],
  );

  const handleModelChange = (id: string) => {
    setModelId(id);
    void persistChatSettings({ modelId: id });
  };

  const handleReasoningChange = (level: string) => {
    setReasoningLevel(level);
    void persistChatSettings({ reasoningLevel: level });
  };

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

  const handleSend = () => {
    const trimmed = content.trim();
    if (!trimmed && files.length === 0) return;
    onSend(trimmed, { modelId, reasoningLevel, presetId, files: files.map((f) => f.file) });
    setContent("");
    setFiles([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
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
            if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
          }}
        >
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={isHero ? "Спросите что угодно" : "Напишите сообщение…"}
            rows={isHero ? 2 : 1}
            autoFocus={autoFocus}
            disabled={disabled}
            className={cn(
              "w-full resize-none bg-transparent text-foreground placeholder:text-muted focus:outline-none",
              isHero
                ? "min-h-[88px] px-5 pt-5 pb-2 text-base leading-6 focus-visible:outline-none"
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
              />
              <ModelSelector value={modelId} onChange={handleModelChange} type="chat" />
              <ReasoningSelector
                modelId={modelId}
                value={reasoningLevel}
                onChange={handleReasoningChange}
              />
              <PresetSelector
                value={presetId}
                onChange={setPresetId}
                presets={presets.filter((p) => p.type === "chat")}
              />
              {chatId ? (
                <ContextInspector
                  chatId={chatId}
                  modelId={modelId}
                  presetId={presetId}
                  draftContent={content}
                />
              ) : null}
            </div>
            <Button
              size="icon"
              className={cn("shrink-0 rounded-full", isHero ? "h-9 w-9" : "h-8 w-8")}
              disabled={disabled || (!content.trim() && files.length === 0)}
              onClick={handleSend}
              aria-label="Отправить"
            >
              <ArrowUp className={isHero ? "h-5 w-5" : "h-4 w-4"} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
