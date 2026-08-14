"use client";

import { getKieModelById } from "@/lib/models/kie/registry";
import { cn } from "@/lib/utils";

interface ReasoningSelectorProps {
  modelId: string;
  value: string;
  onChange: (level: string) => void;
}

const LEVEL_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
  standard: "Standard",
  thinking: "Thinking",
  off: "Standard",
  on: "Thinking",
};

export function ReasoningSelector({ modelId, value, onChange }: ReasoningSelectorProps) {
  const model = getKieModelById(modelId);
  const reasoning = model?.reasoning;

  if (!reasoning || reasoning.control === "none") return null;

  const levels = reasoning.levels;

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-8 rounded-lg border border-border bg-surface px-2 text-xs text-muted-foreground",
        "focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30",
      )}
      aria-label="Reasoning"
    >
      {levels.map((level) => (
        <option key={level} value={level}>
          {LEVEL_LABELS[level] ?? level}
        </option>
      ))}
    </select>
  );
}
