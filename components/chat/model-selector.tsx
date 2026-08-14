"use client";

import {
  getChatModels,
  getImageModels,
  getVideoModels,
  getDefaultLlmModel,
  getDefaultImageModel,
  getDefaultVideoModel,
} from "@/lib/models/registry";
import { cn } from "@/lib/utils";

interface ModelSelectorProps {
  value: string;
  onChange: (id: string) => void;
  type?: "chat" | "image" | "video";
  includeAuto?: boolean;
}

export function ModelSelector({
  value,
  onChange,
  type = "chat",
  includeAuto = false,
}: ModelSelectorProps) {
  const filtered =
    type === "image" ? getImageModels() :
    type === "video" ? getVideoModels() :
    getChatModels();

  const defaultId =
    type === "image" ? getDefaultImageModel().id :
    type === "video" ? getDefaultVideoModel().id :
    getDefaultLlmModel().id;

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-8 rounded-lg border border-border bg-surface px-2 text-xs text-muted-foreground",
        "focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30",
      )}
      aria-label="Выбор модели"
    >
      {includeAuto && type !== "chat" && (
        <option value="auto">Auto</option>
      )}
      {filtered.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}{m.id === defaultId ? " (default)" : ""}
        </option>
      ))}
    </select>
  );
}
