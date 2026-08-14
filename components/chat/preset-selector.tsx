"use client";

import { cn } from "@/lib/utils";
import type { Preset } from "@/lib/types/workspace";

interface PresetSelectorProps {
  value: string;
  onChange: (id: string) => void;
  presets: Preset[];
}

export function PresetSelector({ value, onChange, presets }: PresetSelectorProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-8 rounded-lg border border-border bg-surface px-2 text-xs text-muted-foreground",
        "focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30",
      )}
      aria-label="Выбор пресета"
    >
      {presets.map((p) => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
    </select>
  );
}
