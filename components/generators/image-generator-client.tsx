"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Download,
  FileText,
  Images,
  Layers3,
  Loader2,
  PenTool,
  RefreshCw,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModelSelector } from "@/components/chat/model-selector";
import { QualitySelector } from "@/components/chat/quality-selector";
import {
  GeneratorAssetPicker,
  type GeneratorVisualAsset,
} from "@/components/generators/generator-asset-picker";
import { DEFAULT_IMAGE_MODEL, DEFAULT_MEDIA_QUALITY } from "@/lib/agent/config";
import { getModelById } from "@/lib/models/registry";
import type { MediaQuality } from "@/lib/models/kie/types";
import type { Generation } from "@/lib/types/workspace";
import { cn } from "@/lib/utils";

const DEFAULT_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"];
const IMAGE_MODES = [
  {
    id: "text-to-image",
    label: "Text to Image",
    short: "Текст",
    description: "Создание изображения с нуля по промту",
    icon: WandSparkles,
  },
  {
    id: "image-to-image",
    label: "Image to Image",
    short: "Image → Image",
    description: "Сохраните композицию или стиль исходного изображения",
    icon: Images,
  },
  {
    id: "image-edit",
    label: "Edit",
    short: "Edit",
    description: "Загрузите изображение и опишите, что нужно изменить",
    icon: PenTool,
  },
  {
    id: "reference-images",
    label: "References",
    short: "References",
    description: "Используйте несколько визуальных референсов в одной генерации",
    icon: Layers3,
  },
] as const;

type ImageMode = (typeof IMAGE_MODES)[number]["id"];

type BriefDocument = {
  id: string;
  filename: string;
  mimeType: string;
  context: string;
  truncated: boolean;
};

const ACTIVE_STATUSES = new Set(["queued", "processing", "running"]);

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

function modeNeedsImage(mode: ImageMode): boolean {
  return mode !== "text-to-image";
}

export function ImageGeneratorClient() {
  const [mode, setMode] = useState<ImageMode>("text-to-image");
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState(DEFAULT_IMAGE_MODEL);
  const [quality, setQuality] = useState<MediaQuality>(DEFAULT_MEDIA_QUALITY);
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [numOutputs, setNumOutputs] = useState(1);
  const [references, setReferences] = useState<GeneratorVisualAsset[]>([]);
  const [documents, setDocuments] = useState<BriefDocument[]>([]);
  const [documentUploading, setDocumentUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [history, setHistory] = useState<Generation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);

  const effectiveModelId = modelId === "auto" ? DEFAULT_IMAGE_MODEL : modelId;
  const model = getModelById(effectiveModelId);
  const currentMode = IMAGE_MODES.find((item) => item.id === mode) ?? IMAGE_MODES[0];
  const referenceLimit =
    mode === "reference-images" ? Math.max(1, model?.capabilities.maxReferenceImages ?? 4) : 1;
  const selectedReferences = modeNeedsImage(mode) ? references.slice(0, referenceLimit) : [];
  const canGenerate =
    prompt.trim().length > 0 &&
    (!modeNeedsImage(mode) || selectedReferences.length > 0) &&
    !generating;

  const aspectRatios = model?.capabilities.aspectRatios ?? DEFAULT_ASPECT_RATIOS;
  const resolvedAspectRatio = aspectRatios.includes(aspectRatio)
    ? aspectRatio
    : (aspectRatios[0] ?? "1:1");

  const loadHistory = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch("/api/generations?type=image&limit=30", { cache: "no-store" });
      const payload = await response.json();
      if (payload.ok) setHistory(payload.data.generations ?? []);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/generations?type=image&limit=30", { cache: "no-store" })
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
    const interval = window.setInterval(() => void loadHistory(true), 4_000);
    return () => window.clearInterval(interval);
  }, [hasActiveGeneration, loadHistory]);

  const uploadDocuments = async (files: FileList | File[]) => {
    const selected = Array.from(files).slice(0, Math.max(0, 3 - documents.length));
    if (!selected.length) return;
    setDocumentUploading(true);
    setError(null);
    try {
      const next: BriefDocument[] = [];
      for (const file of selected) {
        const body = new FormData();
        body.append("file", file);
        const response = await fetch("/api/generator-assets", { method: "POST", body });
        const payload = await response.json();
        if (!response.ok || !payload.ok || payload.data?.kind !== "document") {
          throw new Error(payload?.error?.message ?? "Не удалось прочитать документ");
        }
        next.push({
          id: crypto.randomUUID(),
          filename: payload.data.filename,
          mimeType: payload.data.mimeType,
          context: payload.data.context,
          truncated: payload.data.truncated === true,
        });
      }
      setDocuments((previous) => [...previous, ...next].slice(0, 3));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Не удалось прочитать документ");
    } finally {
      setDocumentUploading(false);
      if (documentInputRef.current) documentInputRef.current.value = "";
    }
  };

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setGenerating(true);
    setError(null);
    const documentContext = documents
      .map((document) => `[${document.filename}]\n${document.context}`)
      .join("\n\n")
      .slice(0, 24_000);

    try {
      const response = await fetch("/api/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "image",
          mode,
          prompt: prompt.trim(),
          modelId,
          settings: {
            aspectRatio: resolvedAspectRatio,
            numOutputs,
            quality,
            ...(documentContext ? { documentContext } : {}),
          },
          referenceAssets: selectedReferences.map((asset) => ({
            url: asset.url,
            mimeType: asset.mimeType,
            filename: asset.filename,
            storagePath: asset.storagePath,
            role: mode === "image-edit" ? "edit_source" : "reference",
          })),
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message ?? "Не удалось создать генерацию");
      }
      setHistory((previous) => [payload.data as Generation, ...previous]);
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : "Не удалось создать генерацию");
    } finally {
      setGenerating(false);
    }
  };

  const applyOutputAsReference = (url: string) => {
    setReferences([
      {
        id: crypto.randomUUID(),
        url,
        mimeType: "image/png",
        filename: "generated-reference.png",
        category: "image",
      },
    ]);
    setMode("image-to-image");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background xl:flex-row">
      <section className="w-full shrink-0 border-b border-border bg-surface xl:w-[430px] xl:border-b-0 xl:border-r">
        <div className="h-full overflow-y-auto p-4 md:p-5">
          <div className="mb-5 flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Image Studio</p>
              <h1 className="mt-1 text-xl font-semibold text-foreground">Создание изображений</h1>
            </div>
            <span className="rounded-full border border-border bg-surface-elevated px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
              Durable
            </span>
          </div>

          <div className="mb-5 grid grid-cols-4 rounded-xl border border-border bg-surface-elevated/60 p-1">
            {IMAGE_MODES.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  title={item.label}
                  onClick={() => setMode(item.id)}
                  className={cn(
                    "flex min-w-0 flex-col items-center gap-1 rounded-lg px-1.5 py-2 text-[10px] font-medium transition",
                    mode === item.id
                      ? "bg-surface text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
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
                <ModelSelector value={modelId} onChange={setModelId} type="image" includeAuto />
                <QualitySelector
                  modelId={effectiveModelId}
                  value={quality}
                  onChange={(next) => setQuality(next as MediaQuality)}
                />
              </div>
            </div>

            {modeNeedsImage(mode) ? (
              <GeneratorAssetPicker
                label={mode === "reference-images" ? "Визуальные референсы" : mode === "image-edit" ? "Изображение для редактирования" : "Исходное изображение"}
                hint={currentMode.description}
                value={references}
                onChange={setReferences}
                maxFiles={referenceLimit}
                accept="image"
              />
            ) : (
              <div className="rounded-xl border border-border bg-surface-elevated/35 px-3.5 py-3 text-xs leading-5 text-muted-foreground">
                {currentMode.description}. Для визуального референса переключитесь на Image → Image или References.
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor="image-prompt" className="text-sm font-medium text-foreground">Промт</label>
                <span className="text-[10px] text-muted-foreground">Shift + Enter — новая строка</span>
              </div>
              <textarea
                id="image-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={mode === "image-edit" ? "Опишите точные изменения: что заменить, что сохранить, какой стиль и свет…" : "Опишите сцену, композицию, стиль, свет, камеру, детали и текст в кадре…"}
                rows={7}
                className="min-h-[150px] w-full resize-y rounded-xl border border-border bg-surface-elevated px-3.5 py-3 text-sm leading-6 text-foreground outline-none transition placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent/30"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Brief / документ</p>
                  <p className="text-[11px] text-muted-foreground">PDF, DOCX, TXT или MD — текст попадёт в контекст генерации</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={documentUploading || documents.length >= 3}
                  onClick={() => documentInputRef.current?.click()}
                >
                  {documentUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                  Добавить
                </Button>
              </div>
              {documents.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {documents.map((document) => (
                    <div key={document.id} className="flex max-w-full items-center gap-2 rounded-lg border border-border bg-surface-elevated px-2.5 py-1.5 text-xs">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{document.filename}</span>
                      {document.truncated ? <span className="text-[9px] text-muted-foreground">12k</span> : null}
                      <button type="button" onClick={() => setDocuments((items) => items.filter((item) => item.id !== document.id))}>
                        <X className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <input
                ref={documentInputRef}
                type="file"
                multiple
                accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
                className="hidden"
                onChange={(event) => event.target.files && void uploadDocuments(event.target.files)}
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

            <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-elevated/35 px-3.5 py-3">
              <div>
                <p className="text-sm font-medium text-foreground">Количество вариантов</p>
                <p className="text-[11px] text-muted-foreground">Каждый вариант — отдельная provider task</p>
              </div>
              <div className="flex rounded-lg border border-border bg-surface p-0.5">
                {[1, 2, 3, 4].map((count) => (
                  <button
                    key={count}
                    type="button"
                    onClick={() => setNumOutputs(count)}
                    className={cn(
                      "h-7 w-8 rounded-md text-xs transition",
                      numOutputs === count ? "bg-accent text-white" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {count}
                  </button>
                ))}
              </div>
            </div>

            {error ? (
              <div className="flex gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs leading-5 text-red-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </div>
            ) : null}

            <Button onClick={handleGenerate} disabled={!canGenerate} className="h-11 w-full rounded-xl">
              {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {generating ? "Создаём задачу…" : "Generate"}
            </Button>
            {modeNeedsImage(mode) && selectedReferences.length === 0 ? (
              <p className="text-center text-[11px] text-muted-foreground">Для этого режима сначала добавьте изображение.</p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl p-4 md:p-6">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Результаты</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">История генераций и текущие durable задачи</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadHistory(true)}>
              <RefreshCw className="h-3.5 w-3.5" />
              Обновить
            </Button>
          </div>

          {loading ? (
            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
              {[0, 1, 2].map((item) => <div key={item} className="aspect-square animate-pulse rounded-2xl border border-border bg-surface-elevated" />)}
            </div>
          ) : history.length === 0 ? (
            <div className="grid min-h-[420px] place-items-center rounded-2xl border border-dashed border-border bg-surface/50 p-8 text-center">
              <div>
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-surface-elevated text-muted-foreground"><Sparkles className="h-5 w-5" /></div>
                <p className="mt-4 text-sm font-medium text-foreground">Здесь появятся результаты</p>
                <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">Выберите режим, модель, добавьте референсы при необходимости и запустите генерацию.</p>
              </div>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
              {history.map((generation) => {
                const urls = outputUrls(generation);
                const active = ACTIVE_STATUSES.has(generation.status);
                return (
                  <article key={generation.id} className="overflow-hidden rounded-2xl border border-border bg-surface">
                    <div className="relative aspect-square bg-surface-elevated">
                      {urls[0] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={urls[0]} alt={generation.prompt} className="h-full w-full object-cover" />
                      ) : active ? (
                        <div className="grid h-full place-items-center">
                          <div className="text-center text-muted-foreground">
                            <Loader2 className="mx-auto h-6 w-6 animate-spin" />
                            <p className="mt-3 text-xs">Генерация выполняется…</p>
                          </div>
                        </div>
                      ) : (
                        <div className="grid h-full place-items-center text-muted-foreground"><Images className="h-7 w-7" /></div>
                      )}
                      <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5 rounded-full border border-white/10 bg-black/65 px-2.5 py-1 text-[10px] text-white backdrop-blur">
                        {generation.status === "completed" ? <CheckCircle2 className="h-3 w-3" /> : <Clock3 className="h-3 w-3" />}
                        {statusLabel(generation.status)}
                      </div>
                      {urls.length > 1 ? <span className="absolute right-2.5 top-2.5 rounded-full bg-black/65 px-2 py-1 text-[10px] text-white">+{urls.length - 1}</span> : null}
                    </div>
                    <div className="space-y-3 p-3.5">
                      <div>
                        <p className="line-clamp-2 text-sm leading-5 text-foreground">{generation.prompt}</p>
                        <p className="mt-1 text-[10px] text-muted-foreground">{generation.model_id} · {generation.mode}</p>
                      </div>
                      {urls[0] ? (
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" variant="outline" size="sm" onClick={() => applyOutputAsReference(urls[0])}>
                            <Images className="h-3.5 w-3.5" />
                            В референс
                          </Button>
                          <a href={urls[0]} target="_blank" rel="noreferrer" download>
                            <Button type="button" variant="ghost" size="sm"><Download className="h-3.5 w-3.5" />Скачать</Button>
                          </a>
                        </div>
                      ) : null}
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
