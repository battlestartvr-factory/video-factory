"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TaskCardData } from "@/lib/types/workspace";

interface BatchDetail {
  root: Record<string, unknown>;
  factoryJob: Record<string, unknown> | null;
  conceptRuns: Array<Record<string, unknown>>;
  referenceGenerations: Array<Record<string, unknown>>;
  videoGenerations: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
  videoReviews: Array<Record<string, unknown>>;
}

interface DiscoveryTaskCardProps {
  task: TaskCardData;
  runId: string;
}

type ReviewDecision = "approve" | "revise" | "reject";
type ReviewMedia = "reference" | "video";

interface ReviewItem {
  media: ReviewMedia;
  conceptRunId: string;
  generationId: string;
  conceptId: string;
  momentId: string;
  shotId: string;
  mediaUrl: string | null;
  pitch: string | null;
  action: string | null;
  decision: string | null;
  rawFeedback: string | null;
}

interface PrototypeItem {
  conceptRunId: string;
  conceptId: string;
  pitch: string | null;
  socialVideoUrl: string;
  socialDownloadUrl: string;
  socialDriveWebUrl: string | null;
  socialFilename: string | null;
  socialDurationSeconds: number | null;
  socialWidth: number | null;
  socialHeight: number | null;
  socialFps: number | null;
  socialSizeBytes: number | null;
  masterVideoUrl: string | null;
  masterDownloadUrl: string | null;
  masterDriveWebUrl: string | null;
  masterFilename: string | null;
  masterDurationSeconds: number | null;
  masterWidth: number | null;
  masterHeight: number | null;
  masterFps: number | null;
  masterSizeBytes: number | null;
}

const POLL_MS = 5_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const HUMAN_GATES = new Set(["human_reference_approval_pending", "human_video_approval_pending"]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatBytes(value: number | null): string | null {
  if (!value || value <= 0) return null;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function mediaMetadata(input: {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  sizeBytes: number | null;
}): string[] {
  return [
    input.durationSeconds ? `${input.durationSeconds.toFixed(1).replace(/\.0$/, "")} сек` : null,
    input.width && input.height ? `${input.width}×${input.height}` : null,
    input.fps ? `${input.fps.toFixed(1).replace(/\.0$/, "")} FPS` : null,
    formatBytes(input.sizeBytes),
  ].filter((value): value is string => Boolean(value));
}

function stageLabel(stage: string | null): string {
  const labels: Record<string, string> = {
    objective_ready: "Цель принята",
    concept_generation_pending: "Генерация концептов",
    pre_evaluation_pending: "Предварительная оценка",
    planning_moments_pending: "Планирование gameplay-моментов",
    shot_planning_pending: "Планирование gameplay-кадров",
    reference_image_generation_pending: "Подготовка reference-изображений",
    reference_image_waiting: "Генерация reference-изображений",
    human_reference_approval_pending: "Нужно ваше решение по reference",
    reference_revision_pending: "Перегенерация reference по вашему feedback",
    video_generation_pending: "Reference утверждён — видео разблокировано",
    video_generation_waiting: "Генерация gameplay-видео",
    human_video_approval_pending: "Нужно ваше решение по gameplay-видео",
    video_revision_pending: "Перегенерация gameplay-видео по вашему feedback",
    asset_graph_pending: "Фиксация AssetGraph",
    assembly_pending: "Сборка 16:9 gameplay master и 9:16 social edit",
    prototype_finalization_pending: "Финализация prototype",
    completed: "Prototype готов",
    reference_rejected_no_video: "Reference отклонён — видео не создаётся",
    video_rejected_no_prototype: "Gameplay-видео отклонены — prototype не собирается",
  };
  return stage ? labels[stage] ?? stage : "Запуск discovery";
}

function latestReview(reviews: Array<Record<string, unknown>>, generationId: string) {
  for (let index = reviews.length - 1; index >= 0; index -= 1) {
    const review = reviews[index];
    if (review?.generation_id === generationId) return review ?? null;
  }
  return null;
}

function generationHasOutput(generation: Record<string, unknown> | undefined): boolean {
  if (!generation) return false;
  return array(generation.outputs).some((item) => Boolean(str(object(item).url)));
}

function generationMediaPath(generationId: string): string {
  return `/api/generations/${encodeURIComponent(generationId)}/outputs/0`;
}

function generationMap(items: Array<Record<string, unknown>> | undefined) {
  const map = new Map<string, Record<string, unknown>>();
  for (const generation of items ?? []) {
    const id = str(generation.id);
    if (id) map.set(id, generation);
  }
  return map;
}

function statusIcon(status: string, stage: string | null) {
  if (status === "failed") return { Icon: XCircle, className: "text-red-400", label: "Ошибка" };
  if (status === "cancelled") return { Icon: XCircle, className: "text-zinc-500", label: "Отменено" };
  if (status === "completed") return { Icon: CheckCircle2, className: "text-emerald-400", label: "Завершено" };
  if (stage && HUMAN_GATES.has(stage)) {
    return { Icon: AlertCircle, className: "text-violet-400", label: "Нужно решение" };
  }
  return { Icon: Loader2, className: "text-amber-400", label: "Выполняется" };
}

function decisionLabel(decision: string | null): string {
  if (decision === "approve") return "Утверждено";
  if (decision === "revise") return "Нужна правка";
  if (decision === "reject") return "Отклонено";
  return "Ждёт решения";
}

export function DiscoveryTaskCard({ task, runId }: DiscoveryTaskCardProps) {
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(`/api/discovery/batches/${runId}`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? "Не удалось обновить discovery");
      }
      setDetail(payload.data as BatchDetail);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось обновить discovery");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const jobStatus = str(detail?.factoryJob?.status) ?? task.status;
  const currentStage = str(detail?.factoryJob?.current_stage);
  const progress = Math.max(0, Math.min(100, num(detail?.factoryJob?.progress) ?? task.progress ?? 0));

  useEffect(() => {
    if (TERMINAL_STATUSES.has(jobStatus) || (currentStage && HUMAN_GATES.has(currentStage))) return;
    const timer = window.setInterval(() => void load(true), POLL_MS);
    return () => window.clearInterval(timer);
  }, [currentStage, jobStatus, load]);

  const references = useMemo<ReviewItem[]>(() => {
    if (!detail) return [];
    const generations = generationMap(detail.referenceGenerations);
    const result: ReviewItem[] = [];

    for (const run of detail.conceptRuns ?? []) {
      const outputs = object(run.outputs);
      const request = object(outputs.reference_image_request);
      const generationId = str(request.generation_id);
      const conceptRunId = str(run.id);
      if (!generationId || !conceptRunId) continue;

      const concept = object(outputs.coop_game_concept);
      const moment = object(outputs.gameplay_moment);
      const shot = object(outputs.gameplay_shot);
      const review = latestReview(detail.reviews ?? [], generationId);
      result.push({
        media: "reference",
        conceptRunId,
        generationId,
        conceptId: str(concept.conceptId) ?? str(request.concept_id) ?? "concept",
        momentId: str(moment.momentId) ?? str(request.moment_id) ?? "moment",
        shotId: str(shot.shotId) ?? str(request.shot_id) ?? "shot",
        mediaUrl: generationHasOutput(generations.get(generationId)) ? generationMediaPath(generationId) : null,
        pitch: str(concept.oneSentencePitch),
        action: str(shot.action) ?? str(moment.hypothesis),
        decision: str(review?.decision),
        rawFeedback: str(review?.raw_feedback),
      });
    }
    return result;
  }, [detail]);

  const videos = useMemo<ReviewItem[]>(() => {
    if (!detail) return [];
    const generations = generationMap(detail.videoGenerations);
    const result: ReviewItem[] = [];

    for (const run of detail.conceptRuns ?? []) {
      const outputs = object(run.outputs);
      const request = object(outputs.gameplay_video_request);
      const generationId = str(request.generation_id);
      const conceptRunId = str(run.id);
      if (!generationId || !conceptRunId) continue;

      const concept = object(outputs.coop_game_concept);
      const moment = object(outputs.gameplay_moment);
      const shot = object(outputs.gameplay_shot);
      const review = latestReview(detail.videoReviews ?? [], generationId);
      result.push({
        media: "video",
        conceptRunId,
        generationId,
        conceptId: str(concept.conceptId) ?? str(request.concept_id) ?? "concept",
        momentId: str(moment.momentId) ?? str(request.moment_id) ?? "moment",
        shotId: str(shot.shotId) ?? str(request.shot_id) ?? "shot",
        mediaUrl: generationHasOutput(generations.get(generationId)) ? generationMediaPath(generationId) : null,
        pitch: str(concept.oneSentencePitch),
        action: str(shot.action) ?? str(moment.hypothesis),
        decision: str(review?.decision),
        rawFeedback: str(review?.raw_feedback),
      });
    }
    return result;
  }, [detail]);

  const prototypes = useMemo<PrototypeItem[]>(() => {
    if (!detail) return [];
    const result: PrototypeItem[] = [];
    for (const run of detail.conceptRuns ?? []) {
      const conceptRunId = str(run.id);
      if (!conceptRunId) continue;
      const outputs = object(run.outputs);
      const assembly = object(outputs.prototype_assembly);
      if (assembly.schema !== "gameplay_short_assembly" || !str(assembly.driveFileId)) continue;
      const master = object(assembly.landscapeMaster);
      const baseUrl = `/api/discovery/batches/${encodeURIComponent(runId)}/prototypes/${encodeURIComponent(conceptRunId)}`;
      const concept = object(outputs.coop_game_concept);
      const hasMaster = Boolean(str(master.driveFileId));
      result.push({
        conceptRunId,
        conceptId: str(assembly.conceptId) ?? str(concept.conceptId) ?? "concept",
        pitch: str(concept.oneSentencePitch),
        socialVideoUrl: `${baseUrl}?variant=social`,
        socialDownloadUrl: `${baseUrl}?variant=social&download=1`,
        socialDriveWebUrl: str(assembly.driveWebUrl),
        socialFilename: str(assembly.filename),
        socialDurationSeconds: num(assembly.durationSeconds),
        socialWidth: num(assembly.width),
        socialHeight: num(assembly.height),
        socialFps: num(assembly.fps),
        socialSizeBytes: num(assembly.sizeBytes),
        masterVideoUrl: hasMaster ? `${baseUrl}?variant=master` : null,
        masterDownloadUrl: hasMaster ? `${baseUrl}?variant=master&download=1` : null,
        masterDriveWebUrl: str(master.driveWebUrl),
        masterFilename: str(master.filename),
        masterDurationSeconds: num(master.durationSeconds),
        masterWidth: num(master.width),
        masterHeight: num(master.height),
        masterFps: num(master.fps),
        masterSizeBytes: num(master.sizeBytes),
      });
    }
    return result;
  }, [detail, runId]);

  const submitReview = async (item: ReviewItem, decision: ReviewDecision) => {
    const written = (feedback[item.generationId] ?? item.rawFeedback ?? "").trim();
    if (decision !== "approve" && !written) {
      setError("Для правки или отклонения напишите причину. Комментарий станет опытом ИИ-завода.");
      return;
    }

    setSubmitting(`${item.media}:${item.generationId}:${decision}`);
    setError(null);
    try {
      const endpoint = item.media === "video" ? "video-reviews" : "reference-reviews";
      const response = await fetch(`/api/discovery/batches/${runId}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conceptRunId: item.conceptRunId,
          generationId: item.generationId,
          conceptId: item.conceptId,
          momentId: item.momentId,
          shotId: item.shotId,
          decision,
          feedback: written || null,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? "Не удалось сохранить решение");
      }
      setFeedback((previous) => ({ ...previous, [item.generationId]: "" }));
      await load(true);
      window.setTimeout(() => void load(true), 1_200);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Не удалось сохранить решение");
    } finally {
      setSubmitting(null);
    }
  };

  const renderHumanGate = (items: ReviewItem[], media: ReviewMedia) => {
    const isVideo = media === "video";
    return (
      <div className="border-t border-border bg-surface/40 p-4">
        <div className="mb-3">
          <p className="text-sm font-medium text-foreground">
            {isVideo ? "Gameplay-видео готовы" : "Reference images готовы"}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {isVideo
              ? "ИИ не может забраковать видео. Только вы решаете: утвердить, исправить или отклонить. Prototype собирается только из утверждённых вами видео."
              : "ИИ не бракует картинку. Утвердите, попросите правку или отклоните прямо здесь. Gameplay-видео не запускается без вашего решения."}
          </p>
        </div>

        <div className="space-y-4">
          {items.map((item) => {
            const itemSubmitting = submitting?.startsWith(`${item.media}:${item.generationId}:`) === true;
            return (
              <div key={item.generationId} className="rounded-lg border border-border bg-surface/70 p-3">
                {item.mediaUrl ? (
                  isVideo ? (
                    <div className="aspect-video w-full overflow-hidden rounded-md border border-border bg-black">
                      <video
                        controls
                        playsInline
                        preload="metadata"
                        src={item.mediaUrl}
                        className="h-full w-full bg-black object-contain"
                      >
                        Ваш браузер не поддерживает встроенное видео.
                      </video>
                    </div>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.mediaUrl}
                      alt={item.pitch ?? item.conceptId}
                      className="aspect-video w-full cursor-zoom-in rounded-md border border-border object-contain"
                    />
                  )
                ) : (
                  <div className="reference-placeholder aspect-video w-full rounded-md" />
                )}

                <div className="mt-3">
                  <p className="text-xs font-medium text-foreground">{item.pitch ?? item.conceptId}</p>
                  {item.action && <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.action}</p>}
                </div>

                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  {item.decision === "approve" ? (
                    <Check className="h-4 w-4 text-emerald-400" />
                  ) : item.decision === "revise" ? (
                    <RotateCcw className="h-4 w-4 text-amber-400" />
                  ) : item.decision === "reject" ? (
                    <X className="h-4 w-4 text-red-400" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-violet-400" />
                  )}
                  {decisionLabel(item.decision)}
                </div>

                {!item.decision && (
                  <>
                    <textarea
                      value={feedback[item.generationId] ?? ""}
                      onChange={(event) => setFeedback((previous) => ({ ...previous, [item.generationId]: event.target.value }))}
                      placeholder={
                        isVideo
                          ? "Почему видео хорошее или что нужно исправить? Комментарий сохранится как опыт завода."
                          : "Почему картинка хорошая или что нужно исправить? Комментарий сохранится как опыт завода."
                      }
                      rows={3}
                      disabled={itemSubmitting}
                      className="mt-3 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground outline-none placeholder:text-muted focus:border-accent disabled:opacity-60"
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => void submitReview(item, "approve")} disabled={itemSubmitting}>
                        <Check className="h-3.5 w-3.5" /> Утвердить
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => void submitReview(item, "revise")} disabled={itemSubmitting}>
                        <RotateCcw className="h-3.5 w-3.5" /> Исправить
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => void submitReview(item, "reject")} disabled={itemSubmitting}>
                        <X className="h-3.5 w-3.5" /> Отклонить
                      </Button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const jobError = object(detail?.factoryJob?.error);
  const providerError = str(jobError.message);
  const status = statusIcon(jobStatus, currentStage);
  const StatusIcon = status.Icon;
  const title = str(task.settings?.title) ?? "Поиск новой co-op игры";
  const isHumanGate = Boolean(currentStage && HUMAN_GATES.has(currentStage));

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border bg-surface-elevated shadow-sm">
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 shrink-0 text-accent" />
              <p className="truncate text-sm font-semibold text-foreground">{title}</p>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{stageLabel(currentStage)}</p>
          </div>
          <div className={cn("flex shrink-0 items-center gap-1.5 text-xs font-medium", status.className)}>
            <StatusIcon
              className={cn(
                "h-3.5 w-3.5",
                jobStatus !== "failed" &&
                  jobStatus !== "cancelled" &&
                  jobStatus !== "completed" &&
                  !isHumanGate &&
                  "animate-spin",
              )}
            />
            {status.label}
          </div>
        </div>

        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Прогресс</span>
            <span>{progress}%</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border">
            <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted">Можно оставаться в чате — карточка обновляется автоматически.</p>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            Обновить
          </Button>
        </div>

        {(error || providerError) && (
          <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-300">
            {error ?? providerError}
          </div>
        )}
      </div>

      {currentStage === "human_reference_approval_pending" && references.length > 0 && renderHumanGate(references, "reference")}
      {currentStage === "human_video_approval_pending" && videos.length > 0 && renderHumanGate(videos, "video")}

      {jobStatus === "completed" && prototypes.length > 0 && (
        <div className="border-t border-border bg-surface/40 p-4">
          <div className="mb-3">
            <p className="text-sm font-medium text-foreground">Gameplay prototype готов</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Сохраняются два файла: исходный widescreen gameplay master без social-crop и отдельный 9:16 монтаж для TikTok/Shorts.
            </p>
          </div>

          <div className="space-y-4">
            {prototypes.map((item) => {
              const socialMetadata = mediaMetadata({
                durationSeconds: item.socialDurationSeconds,
                width: item.socialWidth,
                height: item.socialHeight,
                fps: item.socialFps,
                sizeBytes: item.socialSizeBytes,
              });
              const masterMetadata = mediaMetadata({
                durationSeconds: item.masterDurationSeconds,
                width: item.masterWidth,
                height: item.masterHeight,
                fps: item.masterFps,
                sizeBytes: item.masterSizeBytes,
              });

              return (
                <div key={item.conceptRunId} className="rounded-lg border border-border bg-surface/70 p-3">
                  <div>
                    <p className="text-xs font-semibold text-foreground">Gameplay master · 16:9</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">Полный игровой кадр для оценки gameplay до монтажа.</p>
                  </div>
                  {item.masterVideoUrl ? (
                    <div className="mt-2 aspect-video w-full overflow-hidden rounded-lg border border-border bg-black">
                      <video controls playsInline preload="metadata" src={item.masterVideoUrl} className="h-full w-full bg-black object-contain">
                        Ваш браузер не поддерживает встроенное видео.
                      </video>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">Landscape master недоступен для старого prototype.</p>
                  )}
                  <div className="mt-2">
                    {masterMetadata.length > 0 && <p className="text-[11px] text-muted-foreground">{masterMetadata.join(" · ")}</p>}
                    {item.masterFilename && <p className="mt-1 truncate text-[11px] text-muted">{item.masterFilename}</p>}
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      {item.masterDownloadUrl && (
                        <a href={item.masterDownloadUrl} className="rounded-md border border-border px-2.5 py-1.5 text-foreground transition hover:bg-surface-elevated">
                          Скачать gameplay master 16:9
                        </a>
                      )}
                      {item.masterDriveWebUrl && (
                        <a href={item.masterDriveWebUrl} target="_blank" rel="noreferrer" className="rounded-md border border-border px-2.5 py-1.5 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground">
                          Master в Google Drive
                        </a>
                      )}
                    </div>
                  </div>

                  <div className="mt-5 border-t border-border pt-4">
                    <p className="text-xs font-semibold text-foreground">Social edit · 9:16</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">Полный 16:9 gameplay остаётся в центре; фон заполняется размытой копией без обрезания игрового evidence.</p>
                    <div className="mx-auto mt-2 aspect-[9/16] max-h-[70vh] w-full max-w-[360px] overflow-hidden rounded-lg border border-border bg-black">
                      <video controls playsInline preload="metadata" src={item.socialVideoUrl} className="h-full w-full bg-black object-contain">
                        Ваш браузер не поддерживает встроенное видео.
                      </video>
                    </div>
                    <div className="mt-2">
                      {socialMetadata.length > 0 && <p className="text-[11px] text-muted-foreground">{socialMetadata.join(" · ")}</p>}
                      {item.socialFilename && <p className="mt-1 truncate text-[11px] text-muted">{item.socialFilename}</p>}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      <a href={item.socialDownloadUrl} className="rounded-md border border-border px-2.5 py-1.5 text-foreground transition hover:bg-surface-elevated">
                        Скачать social edit 9:16
                      </a>
                      <a href={item.socialVideoUrl} target="_blank" rel="noreferrer" className="rounded-md border border-border px-2.5 py-1.5 text-foreground transition hover:bg-surface-elevated">
                        Открыть отдельно
                      </a>
                      {item.socialDriveWebUrl && (
                        <a href={item.socialDriveWebUrl} target="_blank" rel="noreferrer" className="rounded-md border border-border px-2.5 py-1.5 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground">
                          Social edit в Google Drive
                        </a>
                      )}
                    </div>
                  </div>

                  <div className="mt-4">
                    <p className="text-xs font-medium text-foreground">{item.pitch ?? item.conceptId}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
