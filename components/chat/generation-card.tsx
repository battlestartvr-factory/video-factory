"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Download, ExternalLink, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Generation, GenerationCardData } from "@/lib/types/workspace";

interface GenerationCardProps {
  generation: GenerationCardData;
}

const QUALITY_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

const ACTIVE = new Set(["pending", "queued", "processing"]);

function mediaPath(generationId: string, index: number, download = false): string {
  const base = `/api/generations/${encodeURIComponent(generationId)}/outputs/${index}`;
  return download ? `${base}?download=1` : base;
}

export function GenerationCard({ generation }: GenerationCardProps) {
  const [live, setLive] = useState<GenerationCardData>(generation);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const refresh = async () => {
      try {
        const response = await fetch(`/api/generations/${encodeURIComponent(generation.generationId)}`, {
          cache: "no-store",
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok || cancelled) return;
        const current = payload.data as Generation;
        setLive((previous) => ({
          ...previous,
          status: current.status,
          prompt: current.prompt,
          modelId: current.model_id,
          mode: current.mode,
          outputs: current.outputs,
        }));
        if (!cancelled && ACTIVE.has(current.status)) {
          timer = window.setTimeout(() => void refresh(), 3000);
        }
      } catch {
        if (!cancelled && ACTIVE.has(live.status)) {
          timer = window.setTimeout(() => void refresh(), 5000);
        }
      }
    };

    void refresh();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
    // We intentionally key the polling lifecycle only by generation id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation.generationId]);

  const isProcessing = ACTIVE.has(live.status);
  const isFailed = live.status === "failed";
  const isDone = live.status === "completed";
  const outputCount = Array.isArray(live.outputs) ? live.outputs.filter((item) => item?.url).length : 0;

  return (
    <div className="rounded-xl border border-border bg-surface-elevated p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">
          {live.type === "video" ? "Видео" : "Изображение"} — {live.mode}
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
          {live.status}
        </span>
      </div>

      {(live.modelName || live.modelId || live.quality) && (
        <p className="mt-1 text-xs text-muted-foreground">
          {live.modelName ?? live.modelId}
          {live.quality ? ` · ${QUALITY_LABELS[live.quality] ?? live.quality}` : ""}
        </p>
      )}
      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{live.prompt}</p>

      {outputCount > 0 && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {Array.from({ length: outputCount }, (_, index) => {
            const preview = mediaPath(live.generationId, index);
            const download = mediaPath(live.generationId, index, true);
            return (
              <div key={index} className="overflow-hidden rounded-lg border border-border bg-background">
                {live.type === "video" ? (
                  <video src={preview} controls playsInline preload="metadata" className="aspect-video w-full bg-black object-contain" />
                ) : (
                  <a href={preview} target="_blank" rel="noopener noreferrer" className="block">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={preview} alt={live.prompt} className="aspect-video w-full object-cover" />
                  </a>
                )}
                <div className="flex items-center gap-3 px-2.5 py-2 text-[11px]">
                  <a href={preview} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-accent">
                    <ExternalLink className="h-3 w-3" />Открыть
                  </a>
                  <a href={download} className="inline-flex items-center gap-1 hover:text-accent">
                    <Download className="h-3 w-3" />Скачать
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
