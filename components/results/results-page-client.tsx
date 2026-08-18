"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Download, ExternalLink, Film, ImageIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/states";
import { formatDate } from "@/lib/utils";
import { t } from "@/lib/i18n/dictionary";
import type { Asset } from "@/lib/types/database";
import type { Generation } from "@/lib/types/workspace";

type FilterKind = "all" | "image" | "video" | "document";

const FILTERS: { id: FilterKind; label: string }[] = [
  { id: "all", label: t("assets.filters.all") },
  { id: "image", label: t("assets.filters.images") },
  { id: "video", label: t("assets.filters.videos") },
  { id: "document", label: t("assets.filters.documents") },
];

interface ResultItem {
  id: string;
  kind: string;
  title: string;
  previewUrl?: string | null;
  downloadUrl?: string | null;
  createdAt: string;
  source?: { type: string; href?: string; label?: string };
  status?: string;
}

function generationOutputPath(generationId: string, index = 0, download = false): string {
  const base = `/api/generations/${encodeURIComponent(generationId)}/outputs/${index}`;
  return download ? `${base}?download=1` : base;
}

function assetToResult(a: Asset): ResultItem {
  return {
    id: a.id,
    kind: a.kind,
    title: a.kind,
    previewUrl: a.url,
    downloadUrl: a.url,
    createdAt: a.created_at,
    source: { type: "job", href: `/jobs/${a.job_id}`, label: "Задача" },
  };
}

function generationToResult(g: Generation): ResultItem {
  const hasOutput = Array.isArray(g.outputs) && g.outputs.some((output) => Boolean(output?.url));
  return {
    id: g.id,
    kind: g.type,
    title: g.prompt.slice(0, 80),
    previewUrl: hasOutput ? generationOutputPath(g.id) : null,
    downloadUrl: hasOutput ? generationOutputPath(g.id, 0, true) : null,
    createdAt: g.created_at,
    status: g.status,
    source: g.chat_id
      ? { type: "chat", href: `/chat/${g.chat_id}`, label: "Чат" }
      : undefined,
  };
}

function ResultPreview({ item }: { item: ResultItem }) {
  if (item.kind === "video" && item.previewUrl) {
    return (
      <div className="aspect-video overflow-hidden rounded-xl bg-black/40">
        <video
          src={item.previewUrl}
          controls
          playsInline
          preload="metadata"
          className="h-full w-full object-contain"
        />
      </div>
    );
  }

  if ((item.kind === "image" || item.kind === "thumbnail") && item.previewUrl) {
    return (
      <a
        href={item.previewUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block aspect-video overflow-hidden rounded-xl bg-surface-elevated"
        title="Открыть изображение"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={item.previewUrl} alt={item.title} className="h-full w-full object-cover" />
      </a>
    );
  }

  return (
    <div className="reference-placeholder flex aspect-video items-center justify-center rounded-xl text-muted-foreground">
      {item.kind === "video" ? <Film className="h-7 w-7" /> : <ImageIcon className="h-7 w-7" />}
    </div>
  );
}

export function ResultsPageClient({ initialAssets }: { initialAssets: Asset[] }) {
  const [filter, setFilter] = useState<FilterKind>("all");
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/generations?limit=50", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setGenerations(d.data.generations);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const results: ResultItem[] = [
    ...initialAssets.map(assetToResult),
    ...generations.map(generationToResult),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const filtered = results.filter((r) => {
    if (filter === "all") return true;
    if (filter === "image") return r.kind === "image" || r.kind === "thumbnail";
    if (filter === "video") return r.kind === "video";
    if (filter === "document") return ["text", "source", "other"].includes(r.kind);
    return true;
  });

  return (
    <div className="flex flex-1 flex-col p-4 md:p-8">
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <h1 className="text-2xl font-bold">{t("assets.title")}</h1>

        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === f.id
                  ? "bg-accent-muted text-accent"
                  : "bg-surface-elevated text-muted-foreground hover:text-foreground"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {loading && initialAssets.length === 0 ? (
          <Skeleton className="h-32 w-full" />
        ) : filtered.length === 0 ? (
          <EmptyState title={t("assets.empty")} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((item) => (
              <Card key={item.id} className="overflow-hidden transition-colors hover:border-border">
                <CardContent className="space-y-3 p-3">
                  <ResultPreview item={item} />
                  <div className="px-1 pb-1">
                    <p className="line-clamp-2 text-sm font-medium">{item.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{formatDate(item.createdAt)}</p>
                    {item.status && <p className="mt-1 text-xs text-accent">{item.status}</p>}

                    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                      {item.previewUrl && (
                        <a
                          href={item.previewUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-foreground hover:text-accent"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          Открыть
                        </a>
                      )}
                      {item.downloadUrl && (
                        <a
                          href={item.downloadUrl}
                          className="inline-flex items-center gap-1.5 text-foreground hover:text-accent"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Скачать
                        </a>
                      )}
                      {item.source?.href && (
                        <Link href={item.source.href} className="text-accent hover:underline">
                          → {item.source.label}
                        </Link>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
