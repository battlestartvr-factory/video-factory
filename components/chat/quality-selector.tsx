"use client";

import { getKieModelById } from "@/lib/models/kie/registry";
import { cn } from "@/lib/utils";

interface QualitySelectorProps {
  modelId: string;
  value: string;
  onChange: (quality: string) => void;
}

const QUALITY_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

export function QualitySelector({ modelId, value, onChange }: QualitySelectorProps) {
  const model = getKieModelById(modelId);
  const quality = model?.quality;

  if (!quality) return null;

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-8 rounded-lg border border-border bg-surface px-2 text-xs text-muted-foreground",
        "focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30",
      )}
      aria-label="Quality"
    >
      {quality.levels.map((level) => (
        <option key={level} value={level}>
          {QUALITY_LABELS[level] ?? level}
        </option>
      ))}
    </select>
  );
}
