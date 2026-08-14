"use client";

import { FileText } from "lucide-react";
import type { SourceCitation } from "@/lib/types/workspace";

interface SourcesCardProps {
  sources: SourceCitation[];
}

export function SourcesCard({ sources }: SourcesCardProps) {
  if (!sources.length) return null;

  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Источники</p>
      {sources.map((source, i) => (
        <div
          key={i}
          className="flex gap-2 rounded-lg border border-border bg-surface p-3 text-xs"
        >
          <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
          <div>
            <p className="font-medium text-foreground">{source.filename}</p>
            {source.excerpt && (
              <p className="mt-1 line-clamp-2 text-muted-foreground">{source.excerpt}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
