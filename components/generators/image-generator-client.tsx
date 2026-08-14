"use client";

import { useState, useEffect } from "react";
import { Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea, Label, Select } from "@/components/ui/input";
import { EmptyState, Skeleton } from "@/components/ui/states";
import { ModelSelector } from "@/components/chat/model-selector";
import { QualitySelector } from "@/components/chat/quality-selector";
import { PresetSelector } from "@/components/chat/preset-selector";
import { getModelById } from "@/lib/models/registry";
import { DEFAULT_IMAGE_MODEL, DEFAULT_MEDIA_QUALITY } from "@/lib/agent/config";
import type { MediaQuality } from "@/lib/models/kie/types";
import { t } from "@/lib/i18n/dictionary";
import type { Generation, Preset } from "@/lib/types/workspace";

const IMAGE_MODES = [
  { id: "text-to-image", label: t("images.modes.textToImage") },
  { id: "image-to-image", label: t("images.modes.imageToImage") },
  { id: "image-edit", label: t("images.modes.imageEdit") },
  { id: "reference-images", label: t("images.modes.referenceImages") },
];

export function ImageGeneratorClient() {
  const [mode, setMode] = useState("text-to-image");
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState(DEFAULT_IMAGE_MODEL);
  const [quality, setQuality] = useState<MediaQuality>(DEFAULT_MEDIA_QUALITY);
  const [presetId, setPresetId] = useState("00000000-0000-4000-8000-000000000002");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [resolution, setResolution] = useState("1024");
  const [numOutputs, setNumOutputs] = useState(1);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [history, setHistory] = useState<Generation[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);

  const model = getModelById(modelId);

  useEffect(() => {
    Promise.all([
      fetch("/api/presets?type=image").then((r) => r.json()),
      fetch("/api/generations?type=image").then((r) => r.json()),
    ]).then(([presetRes, genRes]) => {
      if (presetRes.ok) setPresets(presetRes.data.presets);
      if (genRes.ok) setHistory(genRes.data.generations);
      setLoading(false);
    });
  }, []);

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setGenerating(true);
    const res = await fetch("/api/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "image",
        mode,
        prompt,
        modelId,
        presetId,
        settings: { aspectRatio, resolution, numOutputs, quality },
      }),
    });
    const data = await res.json();
    if (data.ok) setHistory((prev) => [data.data, ...prev]);
    setGenerating(false);
  };

  return (
    <div className="flex flex-1 flex-col lg:flex-row">
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-2xl space-y-6">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t("images.title")}</h1>
          </div>

          <div className="flex flex-wrap gap-2">
            {IMAGE_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  mode === m.id
                    ? "bg-accent-muted text-accent"
                    : "bg-surface-elevated text-muted-foreground hover:text-foreground"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="flex flex-wrap gap-3">
                <div>
                  <Label className="mb-1 block text-xs">Модель</Label>
                  <ModelSelector value={modelId} onChange={setModelId} type="image" includeAuto />
                </div>
                <div>
                  <Label className="mb-1 block text-xs">Quality</Label>
                  <QualitySelector
                    modelId={modelId}
                    value={quality}
                    onChange={(q) => setQuality(q as MediaQuality)}
                  />
                </div>
                <div>
                  <Label className="mb-1 block text-xs">Пресет</Label>
                  <PresetSelector value={presetId} onChange={setPresetId} presets={presets} />
                </div>
              </div>

              <div>
                <Label htmlFor="prompt">{t("images.prompt")}</Label>
                <Textarea
                  id="prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={t("images.empty")}
                  rows={4}
                  className="mt-1"
                />
              </div>

              {model?.capabilities.aspectRatios && (
                <div>
                  <Label>Соотношение сторон</Label>
                  <Select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)} className="mt-1">
                    {model.capabilities.aspectRatios.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </Select>
                </div>
              )}

              {model?.capabilities.resolutions && (
                <div>
                  <Label>Разрешение</Label>
                  <Select value={resolution} onChange={(e) => setResolution(e.target.value)} className="mt-1">
                    {model.capabilities.resolutions.map((r) => (
                      <option key={r} value={r}>{r}px</option>
                    ))}
                  </Select>
                </div>
              )}

              <div>
                <Label>Количество</Label>
                <Input
                  type="number"
                  min={1}
                  max={4}
                  value={numOutputs}
                  onChange={(e) => setNumOutputs(Number(e.target.value))}
                  className="mt-1 w-24"
                />
              </div>

              <button
                type="button"
                onClick={() => setAdvancedOpen(!advancedOpen)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {advancedOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                Расширенные настройки
              </button>
              {advancedOpen && (
                <div className="rounded-lg border border-border bg-surface-elevated p-3 text-xs text-muted-foreground">
                  Дополнительные параметры будут доступны после подключения провайдеров.
                </div>
              )}

              <Button onClick={handleGenerate} disabled={generating || !prompt.trim()} className="w-full">
                <Sparkles className="h-4 w-4" />
                {generating ? t("common.loading") : t("images.generate")}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <aside className="w-full border-t border-border lg:w-80 lg:border-l lg:border-t-0">
        <div className="p-4">
          <h2 className="mb-3 text-sm font-semibold text-foreground">{t("images.history")}</h2>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : history.length === 0 ? (
            <EmptyState title={t("images.empty")} />
          ) : (
            <div className="space-y-3">
              {history.map((gen) => (
                <Card key={gen.id}>
                  <CardHeader className="p-3 pb-1">
                    <CardTitle className="line-clamp-1 text-xs font-normal">{gen.prompt}</CardTitle>
                  </CardHeader>
                  <CardContent className="p-3 pt-0">
                    <div className="reference-placeholder aspect-video rounded-lg" />
                    <p className="mt-2 text-[10px] text-muted-foreground">{gen.status} · {gen.model_id}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
