"use client";

import { FileText, Globe } from "lucide-react";
import type { SourceCitation } from "@/lib/types/workspace";

interface SourcesCardProps {
  sources: SourceCitation[];
}

export function SourcesCard({ sources }: SourcesCardProps) {
  if (!sources.length) return null;

  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Источники</p>
      {sources.map((source, i) => {
        const title = source.title || source.filename || source.domain || source.url || "Источник";
        const excerpt = source.excerpt || source.snippet;
        const isWeb = source.source === "web" || Boolean(source.url);
        return (
          <div
            key={source.documentId ?? source.url ?? i}
            className="flex gap-2 rounded-lg border border-border bg-surface p-3 text-xs"
          >
            {isWeb ? (
              <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
            ) : (
              <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
            )}
            <div className="min-w-0">
              {source.url ? (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                >
                  {title}
                </a>
              ) : (
                <p className="font-medium text-foreground">{title}</p>
              )}
              {source.domain ? (
                <p className="text-[10px] text-muted-foreground">{source.domain}</p>
              ) : null}
              {excerpt ? (
                <p className="mt-1 line-clamp-2 text-muted-foreground">{excerpt}</p>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
