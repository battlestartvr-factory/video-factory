"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Film,
  Images,
  Layers3,
  Loader2,
  RefreshCw,
  Sparkles,
  Volume2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModelSelector } from "@/components/chat/model-selector";
import { QualitySelector } from "@/components/chat/quality-selector";
import {
  GeneratorAssetPicker,
  type GeneratorVisualAsset,
} from "@/components/generators/generator-asset-picker";
import { DEFAULT_MEDIA_QUALITY, DEFAULT_VIDEO_MODEL } from "@/lib/agent/config";
import { getModelById } from "@/lib/models/registry";
import type { MediaQuality } from "@/lib/models/kie/types";
import type { Generation } from "@/lib/types/workspace";
import { cn } from "@/lib/utils";

const DEFAULT_VIDEO_RATIOS = ["16:9", "9:16", "1:1"];
const DEFAULT_VIDEO_DURATIONS = [5];
const VIDEO_MODES = [
  { id: "text-to-video", label: "Text to Video", short: "Text", icon: Film },
  { id: "image-to-video", label: "Image to Video", short: "Image", icon: Images },
  { id: "start-end-frames", label: "Start / End", short: "Frames", icon: Layers3 },
  { id: "reference-to-video", label: "References", short: "Refs", icon: Sparkles },
] as const;

type VideoMode = (typeof VIDEO_MODES)[number]["id"];
const ACTIVE_STATUSES = new Set(["queued", "processing", "running"]);

function modeSupported(model: ReturnType<typeof getModelById>, mode: VideoMode): boolean {
  if (!model) return false;
  const caps = model.capabilities;
  if (mode === "text-to-video") return Boolean(caps.textToVideo);
  if (mode === "image-to-video") return Boolean(caps.imageToVideo && caps.startFrame);
  if (mode === "start-end-frames") return Boolean(caps.imageToVideo && caps.startFrame && caps.endFrame);
  return Boolean(caps.referenceToVideo || caps.referenceImages);
}

function outputUrls(generation: Generation): string[] {
  if (!Array.isArray(generation.outputs)) return [];
  return generation.outputs.flatMap((output) =>
    output && typeof output.url === "string" && output.url ? [output.url] : [],
  );
}

function statusLabel(status: string): string {
  if (status === "completed") return "Готово";
  if (status === "failed") return "Ошибка";
  if (status === "cancelled") return "Отменено";
  if (status === "processing" || status === "running") return "Генерация";
  return "В очереди";
}

export function VideoGeneratorClient() {
  const [mode, setMode] = useState<VideoMode>("text-to-video");
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState(DEFAULT_VIDEO_MODEL);
  const [quality, setQuality] = useState<MediaQuality>(DEFAULT_MEDIA_QUALITY);
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [resolution, setResolution] = useState("1080p");
  const [duration, setDuration] = useState(5);
  const [sound, setSound] = useState(true);
  const [multiShot, setMultiShot] = useState(false);
  const [startFrame, setStartFrame] = useState<GeneratorVisualAsset[]>([]);
  const [endFrame, setEndFrame] = useState<GeneratorVisualAsset[]>([]);
  const [references, setReferences] = useState<GeneratorVisualAsset[]>([]);
  const [generating, setGenerating] = useState(false);
  const [history, setHistory] = useState<Generation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const effectiveModelId = modelId === "auto" ? DEFAULT_VIDEO_MODEL : modelId;
  const model = getModelById(effectiveModelId);
  const fallbackMode = VIDEO_MODES.find((item) => modeSupported(model, item.id))?.id ?? "text-to-video";
  const effectiveMode = modeSupported(model, mode) ? mode : fallbackMode;
  const aspectRatios = model?.capabilities.aspectRatios ?? DEFAULT_VIDEO_RATIOS;
  const resolutions = model?.capabilities.resolutions ?? [];
  const durations = model?.capabilities.durations ?? DEFAULT_VIDEO_DURATIONS;
  const referenceLimit = Math.max(1, model?.capabilities.maxReferenceImages ?? 4);
  const resolvedAspectRatio = aspectRatios.includes(aspectRatio)
    ? aspectRatio
    : (aspectRatios[0] ?? "16:9");
  const resolvedResolution = resolutions.length && resolutions.includes(resolution)
    ? resolution
    : resolutions[0];
  const resolvedDuration = durations.includes(duration) ? duration : (durations[0] ?? 5);

  const requiredInputsReady =
    effectiveMode === "text-to-video" ||
    (effectiveMode === "image-to-video" && startFrame.length > 0) ||
    (effectiveMode === "start-end-frames" && startFrame.length > 0 && endFrame.length > 0) ||
    (effectiveMode === "reference-to-video" && references.length > 0);
  const canGenerate = prompt.trim().length > 0 && requiredInputsReady && !generating;

  const loadHistory = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch("/api/generations?type=video&limit=30", { cache: "no-store" });
      const payload = await response.json();
      if (payload.ok) setHistory(payload.data.generations ?? []);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/generations?type=video&limit=30", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled && payload.ok) setHistory(payload.data.generations ?? []);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const hasActiveGeneration = useMemo(
    () => history.some((generation) => ACTIVE_STATUSES.has(generation.status)),
    [history],
  );

  useEffect(() => {
    if (!hasActiveGeneration) return;
    const interval = window.setInterval(() => void loadHistory(true), 5_000);
    return () => window.clearInterval(interval);
  }, [hasActiveGeneration, loadHistory]);

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setGenerating(true);
    setError(null);

    const referenceAssets = [
      ...(effectiveMode === "image-to-video" || effectiveMode === "start-end-frames"
        ? startFrame.slice(0, 1).map((asset) => ({ ...asset, role: "start_frame" }))
        : []),
      ...(effectiveMode === "start-end-frames"
        ? endFrame.slice(0, 1).map((asset) => ({ ...asset, role: "end_frame" }))
        : []),
      ...(effectiveMode === "reference-to-video"
        ? references.slice(0, referenceLimit).map((asset) => ({ ...asset, role: "reference" }))
        : []),
    ].map((asset) => ({
      url: asset.url,
      mimeType: asset.mimeType,
      filename: asset.filename,
      storagePath: asset.storagePath,
      role: asset.role,
    }));

    try {
      const response = await fetch("/api/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "video",
          mode: effectiveMode,
          prompt: prompt.trim(),
          modelId,
          settings: {
            aspectRatio: resolvedAspectRatio,
            ...(resolvedResolution ? { resolution: resolvedResolution } : {}),
            duration: resolvedDuration,
            numOutputs: 1,
            quality,
            sound: Boolean(model?.capabilities.sound || model?.capabilities.audio) ? sound : false,
            multiShot: Boolean(model?.capabilities.multiShot) ? multiShot : false,
          },
          referenceAssets,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message ?? "Не удалось создать видео-задачу");
      }
      setHistory((previous) => [payload.data as Generation, ...previous]);
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : "Не удалось создать видео-задачу");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background xl:flex-row">
      <section className="w-full shrink-0 border-b border-border bg-surface xl:w-[450px] xl:border-b-0 xl:border-r">
        <div className="h-full overflow-y-auto p-4 md:p-5">
          <div className="mb-5 flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Video Studio</p>
              <h1 className="mt-1 text-xl font-semibold text-foreground">Создание видео</h1>
            </div>
            <span className="rounded-full border border-border bg-surface-elevated px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
              Model-aware
            </span>
          </div>

          <div className="mb-5 grid grid-cols-4 rounded-xl border border-border bg-surface-elevated/60 p-1">
            {VIDEO_MODES.map((item) => {
              const Icon = item.icon;
              const supported = modeSupported(model, item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={!supported}
                  title={supported ? item.label : `${model?.name ?? effectiveModelId} не поддерживает этот режим`}
                  onClick={() => supported && setMode(item.id)}
                  className={cn(
                    "flex min-w-0 flex-col items-center gap-1 rounded-lg px-1.5 py-2 text-[10px] font-medium transition",
                    effectiveMode === item.id
                      ? "bg-surface text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                    !supported && "cursor-not-allowed opacity-30",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span className="truncate">{item.short}</span>
                </button>
              );
            })}
          </div>

          <div className="space-y-5">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="text-sm font-medium text-foreground">Модель</label>
                <span className="text-[11px] text-muted-foreground">{model?.name ?? effectiveModelId}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <ModelSelector value={modelId} onChange={setModelId} type="video" includeAuto />
                <QualitySelector
                  modelId={effectiveModelId}
                  value={quality}
                  onChange={(next) => setQuality(next as MediaQuality)}
                />
              </div>
            </div>

            {effectiveMode === "image-to-video" ? (
              <GeneratorAssetPicker
                label="Start Frame"
                hint="Первый кадр задаёт персонажа, композицию и визуальное направление ролика."
                value={startFrame}
                onChange={setStartFrame}
                maxFiles={1}
                accept="image"
              />
            ) : null}

            {effectiveMode === "start-end-frames" ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
                <GeneratorAssetPicker
                  label="Start Frame"
                  hint="Начальный кадр"
                  value={startFrame}
                  onChange={setStartFrame}
                  maxFiles={1}
                  accept="image"
                  compact
                />
                <GeneratorAssetPicker
                  label="End Frame"
                  hint="Финальный кадр — модель построит переход между ними"
                  value={endFrame}
                  onChange={setEndFrame}
                  maxFiles={1}
                  accept="image"
                  compact
                />
              </div>
            ) : null}

            {effectiveMode === "reference-to-video" ? (
              <GeneratorAssetPicker
                label="Reference assets"
                hint="Добавьте изображения персонажей, объектов или стиля. Доступный лимит зависит от модели."
                value={references}
                onChange={setReferences}
                maxFiles={referenceLimit}
                accept="image"
              />
            ) : null}

            {effectiveMode === "text-to-video" ? (
              <div className="rounded-xl border border-border bg-surface-elevated/35 px-3.5 py-3 text-xs leading-5 text-muted-foreground">
                Генерация без стартового кадра. Опишите действие, сцену, движение камеры, свет и желаемый темп.
              </div>
            ) : null}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor="video-prompt" className="text-sm font-medium text-foreground">Промт</label>
                <span className="text-[10px] text-muted-foreground">Сцена · движение · камера · звук</span>
              </div>
              <textarea
                id="video-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Например: cinematic medium shot, персонаж поворачивается к камере, мягкий dolly-in, естественная физика ткани, вечерний контровой свет…"
                rows={7}
                className="min-h-[150px] w-full resize-y rounded-xl border border-border bg-surface-elevated px-3.5 py-3 text-sm leading-6 text-foreground outline-none transition placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent/30"
              />
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">Соотношение сторон</p>
              <div className="flex flex-wrap gap-1.5">
                {aspectRatios.map((ratio) => (
                  <button
                    key={ratio}
                    type="button"
                    onClick={() => setAspectRatio(ratio)}
                    className={cn(
                      "rounded-lg border px-2.5 py-1.5 text-xs transition",
                      resolvedAspectRatio === ratio
                        ? "border-accent bg-accent-muted text-accent"
                        : "border-border bg-surface-elevated text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {ratio}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {resolutions.length ? (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Resolution</label>
                  <select
                    value={resolvedResolution}
                    onChange={(event) => setResolution(event.target.value)}
                    className="h-9 w-full rounded-lg border border-border bg-surface-elevated px-2.5 text-xs text-foreground outline-none"
                  >
                    {resolutions.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </div>
              ) : <div />}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Duration</label>
                <select
                  value={String(resolvedDuration)}
                  onChange={(event) => setDuration(Number(event.target.value))}
                  className="h-9 w-full rounded-lg border border-border bg-surface-elevated px-2.5 text-xs text-foreground outline-none"
                >
                  {durations.map((item) => <option key={item} value={item}>{item} sec</option>)}
                </select>
              </div>
            </div>

            {(model?.capabilities.sound || model?.capabilities.audio || model?.capabilities.multiShot) ? (
              <div className="space-y-2 rounded-xl border border-border bg-surface-elevated/35 p-3.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Model controls</p>
                {(model.capabilities.sound || model.capabilities.audio) ? (
                  <button type="button" onClick={() => setSound((value) => !value)} className="flex w-full items-center justify-between gap-3 text-left">
                    <span className="flex items-center gap-2 text-sm text-foreground"><Volume2 className="h-4 w-4 text-muted-foreground" />Native audio</span>
                    <span className={cn("h-5 w-9 rounded-full p-0.5 transition", sound ? "bg-accent" : "bg-border")}><span className={cn("block h-4 w-4 rounded-full bg-white transition", sound && "translate-x-4")} /></span>
                  </button>
                ) : null}
                {model.capabilities.multiShot ? (
                  <button type="button" onClick={() => setMultiShot((value) => !value)} className="flex w-full items-center justify-between gap-3 text-left">
                    <span className="text-sm text-foreground">Multi-shot composition</span>
                    <span className={cn("h-5 w-9 rounded-full p-0.5 transition", multiShot ? "bg-accent" : "bg-border")}><span className={cn("block h-4 w-4 rounded-full bg-white transition", multiShot && "translate-x-4")} /></span>
                  </button>
                ) : null}
              </div>
            ) : null}

            {error ? (
              <div className="flex gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs leading-5 text-red-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </div>
            ) : null}

            <Button onClick={handleGenerate} disabled={!canGenerate} className="h-11 w-full rounded-xl">
              {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {generating ? "Создаём задачу…" : "Generate video"}
            </Button>
            {!requiredInputsReady ? (
              <p className="text-center text-[11px] text-muted-foreground">Добавьте обязательный визуальный вход для выбранного режима.</p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl p-4 md:p-6">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Видео результаты</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Модель, режим и входные кадры сохраняются вместе с каждой задачей</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadHistory(true)}>
              <RefreshCw className="h-3.5 w-3.5" />
              Обновить
            </Button>
          </div>

          {loading ? (
            <div className="grid gap-4 md:grid-cols-2">
              {[0, 1].map((item) => <div key={item} className="aspect-video animate-pulse rounded-2xl border border-border bg-surface-elevated" />)}
            </div>
          ) : history.length === 0 ? (
            <div className="grid min-h-[420px] place-items-center rounded-2xl border border-dashed border-border bg-surface/50 p-8 text-center">
              <div>
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-surface-elevated text-muted-foreground"><Film className="h-5 w-5" /></div>
                <p className="mt-4 text-sm font-medium text-foreground">Здесь появятся видео</p>
                <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">Форма автоматически перестраивается под Text, Image, Start/End Frames и Reference режимы.</p>
              </div>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {history.map((generation) => {
                const urls = outputUrls(generation);
                const active = ACTIVE_STATUSES.has(generation.status);
                return (
                  <article key={generation.id} className="overflow-hidden rounded-2xl border border-border bg-surface">
                    <div className="relative aspect-video bg-black/30">
                      {urls[0] ? (
                        <video src={urls[0]} controls playsInline className="h-full w-full object-contain" />
                      ) : active ? (
                        <div className="grid h-full place-items-center text-muted-foreground">
                          <div className="text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin" /><p className="mt-3 text-xs">{statusLabel(generation.status)}</p></div>
                        </div>
                      ) : (
                        <div className="grid h-full place-items-center text-muted-foreground"><Film className="h-7 w-7" /></div>
                      )}
                      <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5 rounded-full border border-white/10 bg-black/65 px-2.5 py-1 text-[10px] text-white backdrop-blur">
                        {generation.status === "completed" ? <CheckCircle2 className="h-3 w-3" /> : <Clock3 className="h-3 w-3" />}
                        {statusLabel(generation.status)}
                      </div>
                    </div>
                    <div className="p-3.5">
                      <p className="line-clamp-2 text-sm leading-5 text-foreground">{generation.prompt}</p>
                      <p className="mt-1 text-[10px] text-muted-foreground">{generation.model_id} · {generation.mode}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
