"use client";

import { useState, useEffect } from "react";
import { Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea, Label, Select } from "@/components/ui/input";
import { EmptyState, Skeleton } from "@/components/ui/states";
import { ModelSelector } from "@/components/chat/model-selector";
import { PresetSelector } from "@/components/chat/preset-selector";
import { getModelById } from "@/lib/models/registry";
import { t } from "@/lib/i18n/dictionary";
import type { Generation, Preset } from "@/lib/types/workspace";

const VIDEO_MODES = [
  { id: "text-to-video", label: t("video.modes.textToVideo") },
  { id: "image-to-video", label: t("video.modes.imageToVideo") },
  { id: "start-end-frames", label: t("video.modes.startEndFrames") },
  { id: "reference-to-video", label: t("video.modes.referenceToVideo") },
];

export function VideoGeneratorClient() {
  const [mode, setMode] = useState("text-to-video");
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState("kling-3");
  const [presetId, setPresetId] = useState("00000000-0000-4000-8000-000000000003");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [resolution, setResolution] = useState("1080p");
  const [duration, setDuration] = useState(5);
  const [numOutputs] = useState(1);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [history, setHistory] = useState<Generation[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);

  const model = getModelById(modelId);

  useEffect(() => {
    Promise.all([
      fetch("/api/presets?type=video").then((r) => r.json()),
      fetch("/api/generations?type=video").then((r) => r.json()),
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
        type: "video",
        mode,
        prompt,
        modelId,
        presetId,
        settings: { aspectRatio, resolution, duration, numOutputs },
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
          <h1 className="text-2xl font-bold text-foreground">{t("video.title")}</h1>

          <div className="flex flex-wrap gap-2">
            {VIDEO_MODES.map((m) => (
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
                  <ModelSelector value={modelId} onChange={setModelId} type="video" />
                </div>
                <div>
                  <Label className="mb-1 block text-xs">Пресет</Label>
                  <PresetSelector value={presetId} onChange={setPresetId} presets={presets} />
                </div>
              </div>

              <div>
                <Label htmlFor="prompt">{t("video.prompt")}</Label>
                <Textarea
                  id="prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={t("video.empty")}
                  rows={4}
                  className="mt-1"
                />
              </div>

              {model?.capabilities.startFrame && mode !== "text-to-video" && (
                <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                  Start Frame — перетащите изображение
                </div>
              )}

              {model?.capabilities.endFrame && mode === "start-end-frames" && (
                <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                  End Frame — перетащите изображение
                </div>
              )}

              {model?.capabilities.referenceImages && mode === "reference-to-video" && (
                <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                  Reference Images — перетащите изображения
                </div>
              )}

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
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </Select>
                </div>
              )}

              {model?.capabilities.durations && (
                <div>
                  <Label>Длительность (сек)</Label>
                  <Select value={String(duration)} onChange={(e) => setDuration(Number(e.target.value))} className="mt-1">
                    {model.capabilities.durations.map((d) => (
                      <option key={d} value={d}>{d} сек</option>
                    ))}
                  </Select>
                </div>
              )}

              <button
                type="button"
                onClick={() => setAdvancedOpen(!advancedOpen)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {advancedOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                Расширенные настройки
              </button>

              <Button onClick={handleGenerate} disabled={generating || !prompt.trim()} className="w-full">
                <Sparkles className="h-4 w-4" />
                {generating ? t("common.loading") : t("video.generate")}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <aside className="w-full border-t border-border lg:w-80 lg:border-l lg:border-t-0">
        <div className="p-4">
          <h2 className="mb-3 text-sm font-semibold">{t("video.history")}</h2>
          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : history.length === 0 ? (
            <EmptyState title={t("video.empty")} />
          ) : (
            <div className="space-y-3">
              {history.map((gen) => (
                <Card key={gen.id}>
                  <CardHeader className="p-3 pb-1">
                    <CardTitle className="line-clamp-1 text-xs font-normal">{gen.prompt}</CardTitle>
                  </CardHeader>
                  <CardContent className="p-3 pt-0">
                    <div className="reference-placeholder aspect-video rounded-lg" />
                    <p className="mt-2 text-[10px] text-muted-foreground">{gen.status} · {gen.mode}</p>
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
