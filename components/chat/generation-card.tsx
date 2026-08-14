"use client";

import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GenerationCardData } from "@/lib/types/workspace";

interface GenerationCardProps {
  generation: GenerationCardData;
}

const QUALITY_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

export function GenerationCard({ generation }: GenerationCardProps) {
  const isProcessing = ["pending", "queued", "processing"].includes(generation.status);
  const isFailed = generation.status === "failed";
  const isDone = generation.status === "completed";

  return (
    <div className="rounded-xl border border-border bg-surface-elevated p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">
          {generation.type === "video" ? "Видео" : "Изображение"} — {generation.mode}
        </p>
        <span className={cn(
          "flex items-center gap-1.5 text-xs font-medium",
          isProcessing && "text-amber-400",
          isDone && "text-emerald-400",
          isFailed && "text-red-400",
        )}>
          {isProcessing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {isDone && <CheckCircle2 className="h-3.5 w-3.5" />}
          {isFailed && <XCircle className="h-3.5 w-3.5" />}
          {generation.status}
        </span>
      </div>
      {(generation.modelName || generation.quality) && (
        <p className="mt-1 text-xs text-muted-foreground">
          {generation.modelName}
          {generation.quality ? ` · ${QUALITY_LABELS[generation.quality] ?? generation.quality}` : ""}
        </p>
      )}
      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{generation.prompt}</p>
      {generation.outputs && generation.outputs.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {generation.outputs.map((_, i) => (
            <div key={i} className="reference-placeholder aspect-video rounded-lg" />
          ))}
        </div>
      )}
    </div>
  );
}
