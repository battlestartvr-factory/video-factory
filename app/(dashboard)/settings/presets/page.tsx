"use client";

import { useState, useEffect } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SettingsLayout } from "@/components/settings/settings-nav";
import { t } from "@/lib/i18n/dictionary";
import type { Preset, PresetType } from "@/lib/types/workspace";

const PRESET_TYPES: { value: PresetType; label: string }[] = [
  { value: "chat", label: "Чат" },
  { value: "image", label: "Изображения" },
  { value: "video", label: "Видео" },
];

export default function PresetsSettingsPage() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [filter, setFilter] = useState<PresetType>("chat");
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");

  useEffect(() => {
    fetch(`/api/presets?type=${filter}`)
      .then((r) => r.json())
      .then((d) => { if (d.ok) setPresets(d.data.presets); });
  }, [filter]);

  const handleCreate = async () => {
    if (!name.trim()) return;
    const res = await fetch("/api/presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: filter,
        name,
        settings: { systemPrompt },
      }),
    });
    const data = await res.json();
    if (data.ok) {
      setPresets((prev) => [...prev, data.data]);
      setName("");
      setSystemPrompt("");
      setShowForm(false);
    }
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/presets?id=${id}`, { method: "DELETE" });
    setPresets((prev) => prev.filter((p) => p.id !== id));
  };

  const filtered = presets.filter((p) => p.type === filter);

  return (
    <SettingsLayout>
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-2xl font-bold">{t("settings.presets")}</h1>

        <Select value={filter} onChange={(e) => setFilter(e.target.value as PresetType)}>
          {PRESET_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </Select>

        <div className="space-y-2">
          {filtered.map((preset) => (
            <Card key={preset.id}>
              <CardContent className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium text-sm">{preset.name}</p>
                  {preset.is_system && (
                    <span className="text-xs text-muted-foreground">Системный</span>
                  )}
                  {preset.is_default && (
                    <span className="ml-2 text-xs text-accent">По умолчанию</span>
                  )}
                </div>
                {!preset.is_system && (
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(preset.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        {showForm ? (
          <Card>
            <CardHeader><CardTitle>Новый пресет</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название" />
              <Textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="System prompt (опционально)"
                rows={3}
              />
              <div className="flex gap-2">
                <Button onClick={handleCreate}>{t("common.save")}</Button>
                <Button variant="ghost" onClick={() => setShowForm(false)}>{t("common.cancel")}</Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Button onClick={() => setShowForm(true)}>
            <Plus className="h-4 w-4" />
            Создать пресет
          </Button>
        )}
      </div>
    </SettingsLayout>
  );
}
