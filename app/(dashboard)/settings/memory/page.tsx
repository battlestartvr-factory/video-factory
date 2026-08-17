"use client";

import { useEffect, useState } from "react";
import { Pin, PinOff, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/states";
import { SettingsLayout } from "@/components/settings/settings-nav";
import { t } from "@/lib/i18n/dictionary";
import type { MemoryItem } from "@/lib/types/workspace";

export default function MemorySettingsPage() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  const load = (q?: string) => {
    const params = new URLSearchParams({ scope: "global" });
    if (q) params.set("q", q);
    fetch(`/api/memory?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setItems(d.data.items);
        setLoading(false);
      });
  };

  useEffect(() => { load(); }, []);

  const togglePin = async (item: MemoryItem) => {
    await fetch(`/api/memory?id=${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: !item.pinned }),
    });
    setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, pinned: !i.pinned } : i));
  };

  const toggleEnabled = async (item: MemoryItem) => {
    await fetch(`/api/memory?id=${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !item.enabled }),
    });
    setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, enabled: !i.enabled } : i));
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/memory?id=${id}`, { method: "DELETE" });
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  return (
    <SettingsLayout>
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Память / Learnings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Здесь хранятся не произвольные заметки, а переиспользуемые выводы с источниками и confidence. Новые learnings появляются через явный импорт/обучение в чате и будущие Learning/Market Intelligence pipelines.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Как пополнять память</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>Прикрепите в чат документ, срез рынка или исследование и попросите: «проанализируй и запомни важные инсайты».</p>
            <p>Агент должен извлечь источник, разбить выводы на атомарные learnings и сохранить provenance/evidence. Сырой документ остаётся в Knowledge/Google Drive, а не дублируется целиком в Supabase memory.</p>
          </CardContent>
        </Card>

        <Input
          value={search}
          onChange={(e) => { setSearch(e.target.value); load(e.target.value); }}
          placeholder={t("common.search")}
        />

        {loading ? (
          <Skeleton className="h-20 w-full" />
        ) : items.length === 0 ? (
          <EmptyState
            title="Learnings пока нет"
            description="Добавляйте evidence-backed знания через чат или будущие автоматические learning/intelligence pipelines."
          />
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <Card key={item.id} className={!item.enabled ? "opacity-50" : ""}>
                <CardContent className="flex items-start justify-between gap-3 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{item.content}</p>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {item.category ? <span>Категория: {item.category}</span> : null}
                      {item.source ? <span>Источник: {item.source}</span> : null}
                      {item.learned_from ? <span>Learned from: {item.learned_from}</span> : null}
                      {item.confidence != null ? <span>Confidence: {Math.round(item.confidence * 100)}%</span> : null}
                      <span>Evidence: {Array.isArray(item.evidence) ? item.evidence.length : 0}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="icon" onClick={() => togglePin(item)} title={item.pinned ? "Открепить" : "Закрепить"}>
                      {item.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => toggleEnabled(item)}>
                      <span className="text-xs">{item.enabled ? "Вкл" : "Выкл"}</span>
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(item.id)} title="Удалить learning">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </SettingsLayout>
  );
}
