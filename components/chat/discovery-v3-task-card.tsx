"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConceptReviewPanel, type ConceptReviewDecision } from "@/components/discovery/concept-review-panel";
import type { TaskCardData } from "@/lib/types/workspace";
import { DiscoveryTaskCard } from "./discovery-task-card";

interface DiscoveryV3TaskCardProps {
  task: TaskCardData;
  runId: string;
}

interface BatchDetail {
  root: Record<string, unknown>;
  factoryJob: Record<string, unknown> | null;
  conceptRuns: Array<Record<string, unknown>>;
}

const V3_FRONT_STAGES = new Set([
  "research_acquisition",
  "strong_concept_generation",
  "human_concept_approval_pending",
  "concept_revision_pending",
]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
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

function stageLabel(stage: string | null): string {
  const labels: Record<string, string> = {
    research_acquisition: "Собираю проверенные источники в интернете",
    strong_concept_generation: "Сильная модель анализирует запрос и исследование",
    human_concept_approval_pending: "Три идеи готовы — выберите подходящие",
    concept_revision_pending: "Применяю ваши решения по концептам",
  };
  return stage ? labels[stage] ?? stage : "Запуск поиска игры";
}

function latestReview(reviews: Array<Record<string, unknown>>, conceptId: string) {
  for (let index = reviews.length - 1; index >= 0; index -= 1) {
    const row = reviews[index];
    if (str(row?.concept_id) === conceptId) return row ?? null;
  }
  return null;
}

export function DiscoveryV3TaskCard({ task, runId }: DiscoveryV3TaskCardProps) {
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [reviews, setReviews] = useState<Array<Record<string, unknown>>>([]);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [batchResponse, reviewResponse] = await Promise.all([
        fetch(`/api/discovery/batches/${runId}`, { cache: "no-store" }),
        fetch(`/api/discovery/batches/${runId}/concept-reviews`, { cache: "no-store" }),
      ]);
      const [batchPayload, reviewPayload] = await Promise.all([
        batchResponse.json().catch(() => null),
        reviewResponse.json().catch(() => null),
      ]);
      if (!batchResponse.ok || !batchPayload?.ok) {
        throw new Error(batchPayload?.error?.message ?? "Не удалось обновить поиск игры");
      }
      setDetail(batchPayload.data as BatchDetail);
      if (reviewResponse.ok && reviewPayload?.ok) {
        setReviews(array(reviewPayload.data?.reviews).map(object));
      }
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось обновить поиск игры");
    }
  }, [runId]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const polling = window.setInterval(() => void load(), 5_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(polling);
    };
  }, [load]);

  const jobStatus = str(detail?.factoryJob?.status) ?? task.status;
  const currentStage = str(detail?.factoryJob?.current_stage);
  const progress = Math.max(0, Math.min(100, num(detail?.factoryJob?.progress) ?? task.progress ?? 0));
  const frontStageActive = !currentStage || V3_FRONT_STAGES.has(currentStage);
  const rootOutputs = object(detail?.root?.outputs);
  const researchPack = object(rootOutputs.research_pack);
  const sources = array(researchPack.sources).map(object);
  const coverage = object(researchPack.coverage);
  const state = object(detail?.factoryJob?.state);
  const strongModel = str(state.strong_concept_model) ?? str(task.settings?.strongConceptModel) ?? "gpt-5-6-terra";
  const conceptById = new Map(
    array(rootOutputs.discovery_concepts)
      .map(object)
      .map((concept) => [str(concept.conceptId), concept]),
  );
  const concepts = (detail?.conceptRuns ?? []).flatMap((run) => {
    const outputs = object(run.outputs);
    const concept = object(outputs.coop_game_concept);
    const conceptId = str(concept.conceptId) ?? str(object(run.metadata).concept_id);
    const conceptRunId = str(run.id);
    if (!conceptId || !conceptRunId) return [];
    return [{
      conceptRunId,
      conceptId,
      concept: Object.keys(concept).length ? concept : conceptById.get(conceptId) ?? {},
    }];
  });

  const submitConceptDecision = useCallback(async (
    conceptRunId: string,
    conceptId: string,
    decision: ConceptReviewDecision,
  ) => {
    const note = (feedback[conceptId] ?? "").trim();
    if (decision !== "approve" && !note) {
      setError("Для «Исправить» или «Отклонить» нужен комментарий.");
      return;
    }
    setSubmitting(conceptId);
    setError(null);
    try {
      const response = await fetch(`/api/discovery/batches/${runId}/concept-reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conceptRunId, conceptId, decision, feedback: note || null }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? "Не удалось сохранить решение");
      }
      await load();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Не удалось сохранить решение");
    } finally {
      setSubmitting(null);
    }
  }, [feedback, load, runId]);

  if (!frontStageActive && currentStage) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-xs text-muted-foreground">
          <span className="font-semibold text-emerald-300">Концепты выбраны.</span>{" "}
          Дальше завод создаёт короткий игровой сценарий, ищет визуальные референсы и готовит изображение. Проверка изображения и проверка видео человеком обязательны.
        </div>
        <DiscoveryTaskCard task={task} runId={runId} />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card/70 shadow-sm">
      <div className="space-y-3 border-b border-border bg-background/20 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-violet-400" />
              <p className="text-sm font-semibold text-foreground">Поиск совместной игры</p>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{stageLabel(currentStage)}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void load()} aria-label="Обновить">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${progress}%` }} />
        </div>
        <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
          <span>Источники: {sources.length}</span>
          <span>Концепты: {concepts.length}/3</span>
          <span>Сильная модель: {strongModel}</span>
          <span>Сценарий: {String(task.settings?.gameplayDurationSec ?? 5)} сек.</span>
        </div>
      </div>

      {sources.length > 0 && (
        <details className="border-b border-border p-4">
          <summary className="cursor-pointer text-xs font-semibold text-foreground">Проверенные источники исследования</summary>
          <div className="mt-3 space-y-2">
            {sources.slice(0, 12).map((source, index) => {
              const url = str(source.canonicalUrl);
              return (
                <div key={str(source.sourceRef) ?? String(index)} className="flex items-start justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <p className="truncate text-foreground">{str(source.title) ?? url ?? "Источник"}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {array(source.categories).filter((value): value is string => typeof value === "string").join(" · ") || "исследование"}
                    </p>
                  </div>
                  {url && (
                    <a href={url} target="_blank" rel="noreferrer" className="shrink-0 text-violet-300 hover:text-violet-200">
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </details>
      )}

      {Object.keys(coverage).length > 0 && (
        <div className="border-b border-border p-4 text-xs text-muted-foreground">
          <p className="font-semibold text-foreground">Покрытие исследования</p>
          <p className="mt-1">{Object.entries(coverage).map(([key, value]) => `${key}: ${String(value)}`).join(" · ")}</p>
        </div>
      )}

      {currentStage === "human_concept_approval_pending" && concepts.length > 0 && (
        <div>
          <div className="flex items-center gap-2 border-b border-border bg-violet-500/5 px-4 py-3 text-xs text-violet-200">
            <AlertCircle className="h-4 w-4" />
            Можно утвердить одну, две или все три идеи. «Отклонить» просто убирает конкретную идею. Если отклонить все три, завод создаст новый набор из трёх.
          </div>
          {concepts.map(({ conceptRunId, conceptId, concept }) => (
            <ConceptReviewPanel
              key={conceptRunId}
              concept={concept}
              review={latestReview(reviews, conceptId)}
              feedback={feedback[conceptId] ?? ""}
              onFeedback={(value) => setFeedback((current) => ({ ...current, [conceptId]: value }))}
              onDecision={(decision) => void submitConceptDecision(conceptRunId, conceptId, decision)}
              disabled={submitting === conceptId}
              gateActive
            />
          ))}
        </div>
      )}

      {currentStage === "concept_revision_pending" && (
        <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
          Применяю ваши решения: утверждённые идеи сохраняются, отклонённые удаляются, «Исправить» меняет именно выбранную идею. Новый набор из трёх создаётся только если не осталось ни одной идеи.
        </div>
      )}

      {!error && jobStatus !== "failed" && currentStage !== "human_concept_approval_pending" && currentStage !== "concept_revision_pending" && (
        <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
          {jobStatus === "completed"
            ? <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            : <Loader2 className="h-4 w-4 animate-spin text-amber-400" />}
          {stageLabel(currentStage)}
        </div>
      )}

      {jobStatus === "failed" && (
        <div className="border-t border-red-500/20 bg-red-500/5 p-4 text-xs text-red-200">
          Поиск остановлен. {str(object(detail?.factoryJob?.error).message) ?? "Не удалось завершить текущий этап."}
        </div>
      )}

      {error && <div className="border-t border-red-500/20 p-4 text-xs text-red-300">{error}</div>}
    </div>
  );
}