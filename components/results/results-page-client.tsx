"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
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
  url?: string | null;
  createdAt: string;
  source?: { type: string; href?: string; label?: string };
  status?: string;
}

function assetToResult(a: Asset): ResultItem {
  return {
    id: a.id,
    kind: a.kind,
    title: a.kind,
    url: a.url,
    createdAt: a.created_at,
    source: { type: "job", href: `/jobs/${a.job_id}`, label: "Задача" },
  };
}

function generationToResult(g: Generation): ResultItem {
  return {
    id: g.id,
    kind: g.type,
    title: g.prompt.slice(0, 60),
    createdAt: g.created_at,
    status: g.status,
    source: g.chat_id
      ? { type: "chat", href: `/chat/${g.chat_id}`, label: "Чат" }
      : undefined,
  };
}

export function ResultsPageClient({ initialAssets }: { initialAssets: Asset[] }) {
  const [filter, setFilter] = useState<FilterKind>("all");
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/generations")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setGenerations(d.data.generations);
        setLoading(false);
      });
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
                <CardContent className="p-4">
                  <div className="reference-placeholder mb-3 flex h-32 items-center justify-center rounded-lg text-xs text-muted-foreground">
                    {item.kind}
                  </div>
                  <p className="line-clamp-2 font-medium text-sm">{item.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{formatDate(item.createdAt)}</p>
                  {item.status && (
                    <p className="mt-1 text-xs text-accent">{item.status}</p>
                  )}
                  {item.source?.href && (
                    <Link
                      href={item.source.href}
                      className="mt-2 inline-block text-xs text-accent hover:underline"
                    >
                      → {item.source.label}
                    </Link>
                  )}
                  {item.url && (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 block text-xs text-muted-foreground hover:text-accent"
                    >
                      {t("assets.openDrive")}
                    </a>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
