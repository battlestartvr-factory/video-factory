"use client";

import { getChatModels, getImageModels, getVideoModels } from "@/lib/models/registry";
import { cn } from "@/lib/utils";

interface ModelSelectorProps {
  value: string;
  onChange: (id: string) => void;
  type?: "chat" | "image" | "video";
}

export function ModelSelector({ value, onChange, type = "chat" }: ModelSelectorProps) {
  const filtered =
    type === "image" ? getImageModels() :
    type === "video" ? getVideoModels() :
    getChatModels();

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
      {filtered.map((m) => (
        <option key={m.id} value={m.id}>{m.name}</option>
      ))}
    </select>
  );
}
