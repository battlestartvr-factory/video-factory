"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, RefreshCw, RotateCcw, Search, ShieldCheck, X } from "lucide-react";
import { ConceptReviewPanel, type ConceptReviewDecision } from "./concept-review-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface DiscoveryBatchSummary {
  id: string;
  title: string | null;
  status: string;
  created_at: string;
}

interface BatchDetail {
  root: Record<string, unknown>;
  factoryJob: Record<string, unknown> | null;
  conceptRuns: Array<Record<string, unknown>>;
  referenceGenerations: Array<Record<string, unknown>>;
  videoGenerations: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
  videoReviews: Array<Record<string, unknown>>;
  conceptReviews: Array<Record<string, unknown>>;
}

type ReviewDecision = "approve" | "revise" | "reject";
type ReviewMedia = "reference" | "video";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function latestReview(reviews: Array<Record<string, unknown>>, generationId: string) {
  for (let index = reviews.length - 1; index >= 0; index -= 1) {
    if (reviews[index]?.generation_id === generationId) return reviews[index] ?? null;
  }
  return null;
}

function latestConceptReview(reviews: Array<Record<string, unknown>>, conceptRunId: string) {
  for (let index = reviews.length - 1; index >= 0; index -= 1) {
    if (reviews[index]?.concept_run_id === conceptRunId) return reviews[index] ?? null;
  }
  return null;
}

function generationOutputUrl(generation: Record<string, unknown> | undefined): string | null {
  if (!generation) return null;
  for (const item of array(generation.outputs)) {
    const url = str(object(item).url);
    if (url) return url;
  }
  return null;
}

function generationMap(items: Array<Record<string, unknown>> | undefined) {
  const map = new Map<string, Record<string, unknown>>();
  for (const generation of items ?? []) {
    const id = str(generation.id);
    if (id) map.set(id, generation);
  }
  return map;
}

function decisionLabel(decision: unknown): string {
  if (decision === "approve") return "Утверждено";
  if (decision === "revise") return "Нужна правка";
  if (decision === "reject") return "Отклонено";
  return "Ждёт решения";
}

function stageLabel(stage: string | null): string {
  const labels: Record<string, string> = {
    objective_ready: "Цель принята",
    concept_generation_pending: "Генерация концептов",
    human_concept_approval_pending: "Нужно ваше решение по идеям игр",
    concept_revision_pending: "Переработка / замена концептов по вашему feedback",
    pre_evaluation_pending: "Предварительная оценка утверждённых концептов",
    planning_moments_pending: "Планирование gameplay-моментов",
    shot_planning_pending: "Планирование кадра",
    reference_image_generation_pending: "Подготовка reference-изображений",
    reference_image_waiting: "Генерация reference-изображений",
    human_reference_approval_pending: "Нужно ваше решение по reference",
    reference_revision_pending: "Перегенерация reference по вашему feedback",
    video_generation_pending: "Reference утверждён — видео разблокировано",
    video_generation_waiting: "Генерация gameplay-видео",
    human_video_approval_pending: "Нужно ваше решение по gameplay-видео",
    video_revision_pending: "Перегенерация gameplay-видео по вашему feedback",
    asset_graph_pending: "Фиксация lineage и AssetGraph",
    assembly_pending: "Сборка вертикального prototype",
    prototype_finalization_pending: "Финализация prototype",
    completed: "Prototype готов",
    reference_rejected_no_video: "Reference отклонён — видео не создаётся",
    video_rejected_no_prototype: "Gameplay-видео отклонены — prototype не собирается",
  };
  return stage ? labels[stage] ?? stage : "—";
}

export function DiscoveryPageClient({ initialBatches }: { initialBatches: DiscoveryBatchSummary[] }) {
  const [batches] = useState(initialBatches);
  const [selectedId, setSelectedId] = useState(initialBatches[0]?.id ?? null);
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedbackByGeneration, setFeedbackByGeneration] = useState<Record<string, string>>({});
  const [feedbackByConceptRun, setFeedbackByConceptRun] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);

  const loadDetail = useCallback(async (runId: string, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [detailResponse, conceptReviewsResponse] = await Promise.all([
        fetch(`/api/discovery/batches/${runId}`, { cache: "no-store" }),
        fetch(`/api/discovery/batches/${runId}/concept-reviews`, { cache: "no-store" }),
      ]);
      const payload = await detailResponse.json();
      if (!detailResponse.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? "Не удалось загрузить batch");
      }

      let conceptReviews: Array<Record<string, unknown>> = [];
      if (conceptReviewsResponse.ok) {
        const reviewPayload = await conceptReviewsResponse.json();
        if (reviewPayload?.ok && Array.isArray(reviewPayload?.data?.reviews)) {
          conceptReviews = reviewPayload.data.reviews as Array<Record<string, unknown>>;
        }
      }

      setDetail({ ...(payload.data as Omit<BatchDetail, "conceptReviews">), conceptReviews });
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить batch");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const timer = window.setTimeout(() => void loadDetail(selectedId), 0);
    return () => window.clearTimeout(timer);
  }, [selectedId, loadDetail]);

  const currentStage = str(detail?.factoryJob?.current_stage);
  useEffect(() => {
    if (!selectedId) return;
    const shouldPoll = [
      "concept_generation_pending",
      "concept_revision_pending",
      "pre_evaluation_pending",
      "planning_moments_pending",
      "shot_planning_pending",
      "reference_image_generation_pending",
      "reference_image_waiting",
      "reference_revision_pending",
      "video_generation_pending",
      "video_generation_waiting",
      "video_revision_pending",
      "asset_graph_pending",
      "assembly_pending",
      "prototype_finalization_pending",
    ].includes(currentStage ?? "");
    if (!shouldPoll) return;
    const timer = window.setInterval(() => void loadDetail(selectedId, true), 5_000);
    return () => window.clearInterval(timer);
  }, [currentStage, loadDetail, selectedId]);

  const referenceGenerations = useMemo(
    () => generationMap(detail?.referenceGenerations),
    [detail],
  );
  const videoGenerations = useMemo(
    () => generationMap(detail?.videoGenerations),
    [detail],
  );

  const activeConceptIds = useMemo(() => {
    const ids = new Set<string>();
    const rootOutputs = object(detail?.root.outputs);
    for (const item of array(rootOutputs.discovery_concepts)) {
      const conceptId = str(object(item).conceptId);
      if (conceptId) ids.add(conceptId);
    }
    return ids;
  }, [detail]);

  const visibleConceptRuns = useMemo(() => {
    const runs = detail?.conceptRuns ?? [];
    if (!activeConceptIds.size) return runs;
    return runs.filter((run) => {
      const metadata = object(run.metadata);
      const outputs = object(run.outputs);
      const concept = object(outputs.coop_game_concept);
      const conceptId = str(metadata.concept_id) ?? str(concept.conceptId);
      return Boolean(conceptId && activeConceptIds.has(conceptId));
    });
  }, [activeConceptIds, detail]);

  const submitConceptReview = async (input: {
    conceptRunId: string;
    conceptId: string;
    decision: ConceptReviewDecision;
  }) => {
    if (!selectedId) return;
    const feedback = feedbackByConceptRun[input.conceptRunId]?.trim() ?? "";
    if (input.decision !== "approve" && !feedback) {
      setError("Для исправления или отклонения идеи напишите причину. Она станет negative/positive memory завода.");
      return;
    }

    setSubmitting(`concept:${input.conceptRunId}:${input.decision}`);
    setError(null);
    try {
      const response = await fetch(`/api/discovery/batches/${selectedId}/concept-reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conceptRunId: input.conceptRunId,
          conceptId: input.conceptId,
          decision: input.decision,
          feedback: feedback || null,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? "Не удалось сохранить решение по идее");
      }
      await loadDetail(selectedId, true);
      window.setTimeout(() => void loadDetail(selectedId, true), 1200);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Не удалось сохранить решение по идее");
    } finally {
      setSubmitting(null);
    }
  };

  const submitReview = async (input: {
    media: ReviewMedia;
    conceptRunId: string;
    generationId: string;
    conceptId: string;
    momentId: string;
    shotId: string;
    decision: ReviewDecision;
  }) => {
    if (!selectedId) return;
    const feedback = feedbackByGeneration[input.generationId]?.trim() ?? "";
    if (input.decision !== "approve" && !feedback) {
      setError("Для правки или отклонения напишите причину. Комментарий станет опытом ИИ-завода.");
      return;
    }

    setSubmitting(`${input.media}:${input.generationId}:${input.decision}`);
    setError(null);
    try {
      const endpoint = input.media === "video" ? "video-reviews" : "reference-reviews";
      const response = await fetch(`/api/discovery/batches/${selectedId}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conceptRunId: input.conceptRunId,
          generationId: input.generationId,
          conceptId: input.conceptId,
          momentId: input.momentId,
          shotId: input.shotId,
          decision: input.decision,
          feedback: feedback || null,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message ?? "Не удалось сохранить решение");
      await loadDetail(selectedId, true);
      window.setTimeout(() => void loadDetail(selectedId, true), 1200);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Не удалось сохранить решение");
    } finally {
      setSubmitting(null);
    }
  };

  const progress = numberValue(detail?.factoryJob?.progress) ?? 0;
  const conceptGateActive = currentStage === "human_concept_approval_pending";

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 px-4 py-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Search className="h-5 w-5 text-accent" />
            <h1 className="text-2xl font-semibold text-foreground">Поиск игры</h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Концепт → ваше решение → gameplay-момент → reference → ваше решение → gameplay-видео → ваше решение → prototype.
          </p>
        </div>
        {selectedId && (
          <Button variant="secondary" size="sm" onClick={() => void loadDetail(selectedId)} disabled={loading}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            Обновить
          </Button>
        )}
      </div>

      <div className="rounded-xl border border-accent/30 bg-accent/5 p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
          <div>
            <p className="text-sm font-medium text-foreground">Human approval gates активны для идей, картинок и видео</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Сначала вы утверждаете саму игру. «Исправить» создаёт новую версию той же идеи по вашему feedback. «Отклонить и заменить» полностью убирает идею из активного набора и требует механически нового концепта, а не рескина. Только после approval завод может перейти к gameplay-моментам и генерации медиа.
            </p>
          </div>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>}

      <div className="grid min-h-0 gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="rounded-xl border border-border bg-surface/70 p-3">
          <p className="px-2 pb-2 text-xs font-semibold uppercase tracking-wider text-muted">Discovery batches</p>
          {batches.length === 0 ? (
            <p className="px-2 py-6 text-sm text-muted-foreground">Запусков пока нет.</p>
          ) : (
            <div className="space-y-1">
              {batches.map((batch) => (
                <button
                  key={batch.id}
                  type="button"
                  onClick={() => setSelectedId(batch.id)}
                  className={cn(
                    "w-full rounded-lg px-3 py-2.5 text-left transition-colors",
                    selectedId === batch.id ? "bg-accent-muted" : "hover:bg-surface-hover",
                  )}
                >
                  <p className="truncate text-sm font-medium text-foreground">{batch.title || "Без названия"}</p>
                  <p className="mt-1 text-[11px] text-muted">{new Date(batch.created_at).toLocaleString("ru-RU")}</p>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="min-w-0 space-y-4">
          {!detail ? (
            <div className="rounded-xl border border-border bg-surface/60 p-8 text-center text-sm text-muted-foreground">
              {loading ? "Загружаем discovery batch…" : "Выберите discovery batch."}
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-border bg-surface/70 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">{str(detail.root.title) || "Discovery batch"}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{stageLabel(currentStage)}</p>
                  </div>
                  <Badge>{progress}%</Badge>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-hover">
                  <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
                </div>
              </div>

              {visibleConceptRuns.map((run) => {
                const outputs = object(run.outputs);
                const concept = object(outputs.coop_game_concept);
                const evaluation = object(outputs.concept_pre_evaluation);
                const moment = object(outputs.gameplay_moment);
                const shot = object(outputs.gameplay_shot);
                const referenceRequest = object(outputs.reference_image_request);
                const videoRequest = object(outputs.gameplay_video_request);
                const prototypeAssembly = object(outputs.prototype_assembly);

                const generationId = str(referenceRequest.generation_id);
                const generation = generationId ? referenceGenerations.get(generationId) : undefined;
                const imageUrl = generationOutputUrl(generation);
                const review = generationId ? latestReview(detail.reviews, generationId) : null;

                const videoGenerationId = str(videoRequest.generation_id);
                const videoGeneration = videoGenerationId ? videoGenerations.get(videoGenerationId) : undefined;
                const videoUrl = generationOutputUrl(videoGeneration);
                const videoReview = videoGenerationId ? latestReview(detail.videoReviews, videoGenerationId) : null;

                const conceptId = str(concept.conceptId) ?? str(referenceRequest.concept_id) ?? str(videoRequest.concept_id) ?? "concept";
                const momentId = str(moment.momentId) ?? str(referenceRequest.moment_id) ?? str(videoRequest.moment_id) ?? "moment";
                const shotId = str(shot.shotId) ?? str(referenceRequest.shot_id) ?? str(videoRequest.shot_id) ?? "shot";
                const conceptRunId = str(run.id) ?? "";
                const conceptReview = latestConceptReview(detail.conceptReviews, conceptRunId);
                const prototypeReady = Boolean(str(prototypeAssembly.driveFileId));
                const prototypeDuration = numberValue(prototypeAssembly.durationSeconds);
                const prototypeWidth = numberValue(prototypeAssembly.width);
                const prototypeHeight = numberValue(prototypeAssembly.height);
                const prototypeFps = numberValue(prototypeAssembly.fps);
                const preEvalPassed =
                  evaluation.coOpDependency === "pass" &&
                  evaluation.instantReadability === "pass" &&
                  evaluation.buildability === "pass";

                return (
                  <article key={conceptRunId} className="overflow-hidden rounded-xl border border-border bg-surface/70">
                    <div className="border-b border-border p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="text-base font-semibold text-foreground">{str(concept.oneSentencePitch) || conceptId}</h3>
                          {str(concept.coopDependency) && (
                            <p className="mt-2 text-sm leading-6 text-muted-foreground"><span className="font-medium text-foreground">Co-op dependency:</span> {str(concept.coopDependency)}</p>
                          )}
                        </div>
                        {prototypeReady ? (
                          <Badge variant="success">prototype ready</Badge>
                        ) : Boolean(evaluation.coOpDependency) ? (
                          <Badge variant={preEvalPassed ? "success" : "warning"}>
                            pre-eval {preEvalPassed ? "pass" : "check"}
                          </Badge>
                        ) : conceptReview?.decision === "approve" ? (
                          <Badge variant="success">human-approved concept</Badge>
                        ) : null}
                      </div>
                    </div>

                    <ConceptReviewPanel
                      concept={concept}
                      review={conceptReview}
                      feedback={feedbackByConceptRun[conceptRunId] ?? str(conceptReview?.raw_feedback) ?? ""}
                      onFeedback={(value) => setFeedbackByConceptRun((current) => ({ ...current, [conceptRunId]: value }))}
                      onDecision={(decision) => void submitConceptReview({ conceptRunId, conceptId, decision })}
                      disabled={submitting !== null}
                      gateActive={conceptGateActive}
                    />

                    {Boolean(moment.momentId) && (
                      <div className="grid gap-3 border-b border-border p-4 md:grid-cols-2">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Gameplay moment</p>
                          <p className="mt-1 text-sm leading-6 text-foreground">{str(moment.hypothesis)}</p>
                        </div>
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Что должно быть видно</p>
                          <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
                            {array(moment.requiredVisualEvidence).map((item, index) => (
                              <li key={`${String(item)}-${index}`}>• {String(item)}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    )}

                    <div className="p-4">
                      {!generationId ? (
                        <p className="text-sm text-muted-foreground">
                          {conceptGateActive ? "Media generation заблокирована до утверждения идеи." : "Reference ещё не поставлен в очередь."}
                        </p>
                      ) : !imageUrl ? (
                        <div className="rounded-lg border border-dashed border-border p-6 text-center">
                          <RefreshCw className={cn("mx-auto h-5 w-5 text-muted", generation?.status !== "failed" && "animate-spin")} />
                          <p className="mt-2 text-sm text-muted-foreground">
                            {generation?.status === "failed" ? "Reference generation завершилась ошибкой." : "Генерируется gameplay reference…"}
                          </p>
                        </div>
                      ) : (
                        <div className="grid gap-4 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
                          <div className="overflow-hidden rounded-xl border border-border bg-black/20">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={imageUrl} alt={`Gameplay reference ${conceptId}`} className="aspect-[9/16] w-full object-contain" />
                          </div>
                          <div className="space-y-3">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <p className="text-sm font-medium text-foreground">Ваше решение по reference</p>
                                <p className="mt-0.5 text-xs text-muted-foreground">ИИ не бракует картинку. Только ваше approve разблокирует видео.</p>
                              </div>
                              <Badge variant={review?.decision === "approve" ? "success" : review?.decision === "reject" ? "danger" : review?.decision === "revise" ? "warning" : "secondary"}>
                                {decisionLabel(review?.decision)}
                              </Badge>
                            </div>

                            <textarea
                              value={feedbackByGeneration[generationId] ?? str(review?.raw_feedback) ?? ""}
                              onChange={(event) => setFeedbackByGeneration((current) => ({ ...current, [generationId]: event.target.value }))}
                              placeholder="Почему вы принимаете картинку или что нужно изменить? Комментарий сохранится как опыт завода."
                              className="min-h-28 w-full resize-y rounded-lg border border-border bg-background/60 px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted focus:border-accent"
                            />

                            <div className="flex flex-wrap gap-2">
                              <Button size="sm" onClick={() => void submitReview({ media: "reference", conceptRunId, generationId, conceptId, momentId, shotId, decision: "approve" })} disabled={submitting !== null}>
                                <Check className="h-4 w-4" /> Утвердить
                              </Button>
                              <Button size="sm" variant="secondary" onClick={() => void submitReview({ media: "reference", conceptRunId, generationId, conceptId, momentId, shotId, decision: "revise" })} disabled={submitting !== null}>
                                <RotateCcw className="h-4 w-4" /> Исправить
                              </Button>
                              <Button size="sm" variant="danger" onClick={() => void submitReview({ media: "reference", conceptRunId, generationId, conceptId, momentId, shotId, decision: "reject" })} disabled={submitting !== null}>
                                <X className="h-4 w-4" /> Отклонить
                              </Button>
                            </div>

                            {Boolean(review?.structured_feedback) && (
                              <div className="rounded-lg border border-border bg-background/40 p-3">
                                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Память из feedback</p>
                                <p className="mt-1 text-xs leading-5 text-muted-foreground">{str(object(review?.structured_feedback).summary)}</p>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {videoGenerationId && (
                      <div className="border-t border-border bg-background/10 p-4">
                        {!videoUrl ? (
                          <div className="rounded-lg border border-dashed border-border p-6 text-center">
                            <RefreshCw className={cn("mx-auto h-5 w-5 text-muted", videoGeneration?.status !== "failed" && "animate-spin")} />
                            <p className="mt-2 text-sm text-muted-foreground">
                              {videoGeneration?.status === "failed" ? "Gameplay-видео завершилось ошибкой провайдера." : "Генерируется gameplay-видео…"}
                            </p>
                          </div>
                        ) : (
                          <div className="grid gap-4 xl:grid-cols-[minmax(0,520px)_minmax(0,1fr)]">
                            <div className="overflow-hidden rounded-xl border border-border bg-black">
                              <video controls playsInline preload="metadata" src={videoUrl} className="aspect-video w-full object-contain" />
                            </div>
                            <div className="space-y-3">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <p className="text-sm font-medium text-foreground">Ваше решение по gameplay-видео</p>
                                  <p className="mt-0.5 text-xs text-muted-foreground">ИИ не может забраковать это видео. Prototype собирается только из видео, которые утвердили вы.</p>
                                </div>
                                <Badge variant={videoReview?.decision === "approve" ? "success" : videoReview?.decision === "reject" ? "danger" : videoReview?.decision === "revise" ? "warning" : "secondary"}>
                                  {decisionLabel(videoReview?.decision)}
                                </Badge>
                              </div>

                              <textarea
                                value={feedbackByGeneration[videoGenerationId] ?? str(videoReview?.raw_feedback) ?? ""}
                                onChange={(event) => setFeedbackByGeneration((current) => ({ ...current, [videoGenerationId]: event.target.value }))}
                                placeholder="Почему видео хорошее или что нужно исправить? Например: движение камеры, действие игроков, физика, читаемость co-op."
                                className="min-h-28 w-full resize-y rounded-lg border border-border bg-background/60 px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted focus:border-accent"
                              />

                              <div className="flex flex-wrap gap-2">
                                <Button size="sm" onClick={() => void submitReview({ media: "video", conceptRunId, generationId: videoGenerationId, conceptId, momentId, shotId, decision: "approve" })} disabled={submitting !== null}>
                                  <Check className="h-4 w-4" /> Утвердить
                                </Button>
                                <Button size="sm" variant="secondary" onClick={() => void submitReview({ media: "video", conceptRunId, generationId: videoGenerationId, conceptId, momentId, shotId, decision: "revise" })} disabled={submitting !== null}>
                                  <RotateCcw className="h-4 w-4" /> Исправить
                                </Button>
                                <Button size="sm" variant="danger" onClick={() => void submitReview({ media: "video", conceptRunId, generationId: videoGenerationId, conceptId, momentId, shotId, decision: "reject" })} disabled={submitting !== null}>
                                  <X className="h-4 w-4" /> Отклонить
                                </Button>
                              </div>

                              {Boolean(videoReview?.structured_feedback) && (
                                <div className="rounded-lg border border-border bg-background/40 p-3">
                                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Память из video feedback</p>
                                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{str(object(videoReview?.structured_feedback).summary)}</p>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {prototypeReady && selectedId && (
                      <div className="border-t border-border bg-background/20 p-4">
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-foreground">Готовый gameplay prototype</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Детерминированная FFmpeg-сборка только из human-approved gameplay-видео; durable-копия хранится в Google Drive.
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {prototypeWidth && prototypeHeight && <Badge variant="secondary">{prototypeWidth}×{prototypeHeight}</Badge>}
                            {prototypeFps && <Badge variant="secondary">{Math.round(prototypeFps)} fps</Badge>}
                            {prototypeDuration && <Badge variant="secondary">{prototypeDuration.toFixed(1)} s</Badge>}
                          </div>
                        </div>
                        <div className="max-w-[420px] overflow-hidden rounded-xl border border-border bg-black">
                          <video
                            controls
                            playsInline
                            preload="metadata"
                            src={`/api/discovery/batches/${selectedId}/prototypes/${conceptRunId}`}
                            className="aspect-[9/16] w-full object-contain"
                          />
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
