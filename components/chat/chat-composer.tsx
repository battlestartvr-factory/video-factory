"use client";

import { useState, useRef, useCallback } from "react";
import { Send, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getAcceptString } from "@/lib/attachments/mime";
import { DEFAULT_LLM_MODEL, DEFAULT_REASONING_LEVEL } from "@/lib/agent/config";
import { ModelSelector } from "./model-selector";
import { ReasoningSelector } from "./reasoning-selector";
import { PresetSelector } from "./preset-selector";
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
}

export function ChatComposer({
  onSend,
  disabled,
  presets = [],
  chatId,
  defaultModelId = DEFAULT_LLM_MODEL,
  defaultReasoningLevel = DEFAULT_REASONING_LEVEL,
  defaultPresetId,
}: ChatComposerProps) {
  const [content, setContent] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [modelId, setModelId] = useState(defaultModelId);
  const [reasoningLevel, setReasoningLevel] = useState(defaultReasoningLevel);
  const [presetId, setPresetId] = useState(defaultPresetId ?? "00000000-0000-4000-8000-000000000001");
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  return (
    <div className="border-t border-border bg-surface/80 backdrop-blur-sm">
      <div className="mx-auto max-w-3xl px-4 py-3">
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
            "rounded-xl border border-border bg-surface-elevated shadow-md transition-colors",
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
            placeholder="Напишите сообщение…"
            rows={1}
            disabled={disabled}
            className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground placeholder:text-muted focus:outline-none"
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip className="h-4 w-4" />
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
            </div>
            <Button
              size="icon"
              className="h-8 w-8"
              disabled={disabled || (!content.trim() && files.length === 0)}
              onClick={handleSend}
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
