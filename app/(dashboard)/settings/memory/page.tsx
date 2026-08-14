"use client";

import { useState, useEffect } from "react";
import { Pin, PinOff, Trash2, Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/states";
import { SettingsLayout } from "@/components/settings/settings-nav";
import { t } from "@/lib/i18n/dictionary";
import type { MemoryItem } from "@/lib/types/workspace";

export default function MemorySettingsPage() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [search, setSearch] = useState("");
  const [newContent, setNewContent] = useState("");
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

  const handleAdd = async () => {
    if (!newContent.trim()) return;
    const res = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", content: newContent }),
    });
    const data = await res.json();
    if (data.ok) {
      setItems((prev) => [data.data, ...prev]);
      setNewContent("");
    }
  };

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
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-2xl font-bold">{t("settings.memory")}</h1>

        <Card>
          <CardHeader><CardTitle>{t("common.add")}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="Добавить факт в глобальную память…"
              rows={2}
            />
            <Button onClick={handleAdd} disabled={!newContent.trim()}>
              <Plus className="h-4 w-4" />
              {t("common.add")}
            </Button>
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
          <EmptyState title="Память пуста" description="Добавьте факты, предпочтения и правила для агента." />
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <Card key={item.id} className={!item.enabled ? "opacity-50" : ""}>
                <CardContent className="flex items-start justify-between gap-3 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm">{item.content}</p>
                    {item.category && (
                      <p className="mt-1 text-xs text-muted-foreground">{item.category}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="icon" onClick={() => togglePin(item)}>
                      {item.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => toggleEnabled(item)}>
                      <span className="text-xs">{item.enabled ? "Вкл" : "Выкл"}</span>
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(item.id)}>
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
