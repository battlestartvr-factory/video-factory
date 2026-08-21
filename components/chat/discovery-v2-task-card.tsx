"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TaskCardData } from "@/lib/types/workspace";
import { researchUserFacingFailure } from "@/lib/research-intelligence/user-facing-errors";
import { ConceptReviewPanel, type ConceptReviewDecision } from "@/components/discovery/concept-review-panel";
import { DiscoveryTaskCard } from "./discovery-task-card";
import { ResearchLiveTrace } from "./research-live-trace";

interface DiscoveryV2TaskCardProps {
  task: TaskCardData;
  runId: string;
}

interface BatchDetail {
  root: Record<string, unknown>;
  factoryJob: Record<string, unknown> | null;
  conceptRuns: Array<Record<string, unknown>>;
}

interface ResearchDetail {
  researchRun: Record<string, unknown> | null;
  scouts: Array<Record<string, unknown>>;
  sources: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  evidencePack: Record<string, unknown> | null;
  conceptDesigners: Array<Record<string, unknown>>;
  rawCandidates: Array<Record<string, unknown>>;
  curation: Record<string, unknown> | null;
  externalVisualReferences: Array<Record<string, unknown>>;
  imageReferenceSets: Array<Record<string, unknown>>;
}

interface Readiness {
  readyForManualV2Test?: boolean;
  kieConfigured?: boolean;
  kieOnlySearchEnabled?: boolean;
  googleDriveConfigured?: boolean;
  mockWorkflows?: boolean;
  paidProbePerformed?: boolean;
}

const V2_FRONT_STAGES = new Set([
  "research_planning",
  "research_fanout",
  "waiting_research_scouts",
  "research_synthesis",
  "concept_council_fanout",
  "waiting_concept_council",
  "concept_curation",
  "human_concept_approval_pending",
  "concept_revision_pending",
]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
    research_planning: "Планирование исследования",
    research_fanout: "Запуск исследователей",
    waiting_research_scouts: "Исследователи изучают рынок и механики",
    research_synthesis: "Сборка результатов исследования",
    concept_council_fanout: "Запуск дизайнеров концептов",
    waiting_concept_council: "Дизайнеры создают варианты игр",
    concept_curation: "Отбор наиболее разных игровых концептов",
    human_concept_approval_pending: "Проверка концептов — выберите подходящие идеи",
    concept_revision_pending: "Переработка концептов по вашему комментарию",
  };
  return stage ? labels[stage] ?? stage : "Этап 4.5 запускается";
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: "в очереди",
    waiting: "ожидает",
    running: "работает",
    completed: "завершён",
    failed: "ошибка",
    cancelled: "отменён",
  };
  return labels[status] ?? status;
}

function roleLabel(role: string): string {
  const labels: Record<string, string> = {
    mechanics_explorer: "Исследователь механик",
    social_viral_designer: "Дизайнер социальных моментов",
    buildable_systems_designer: "Дизайнер реализуемых систем",
    market_scout: "Исследователь рынка",
    player_sentiment_scout: "Исследователь отзывов игроков",
    competitor_scout: "Исследователь конкурентов",
    visual_scout: "Исследователь визуальных референсов",
    mechanic_scout: "Исследователь механик",
  };
  return labels[role] ?? role.replaceAll("_", " ");
}

function latestReview(reviews: Array<Record<string, unknown>>, conceptId: string) {
  for (let index = reviews.length - 1; index >= 0; index -= 1) {
    const row = reviews[index];
    if (str(row?.concept_id) === conceptId) return row ?? null;
  }
  return null;
}

function statusTone(status: string | null): string {
  if (status === "completed") return "text-emerald-400";
  if (status === "failed") return "text-red-400";
  if (status === "waiting") return "text-violet-400";
  return "text-amber-400";
}

export function DiscoveryV2TaskCard({ task, runId }: DiscoveryV2TaskCardProps) {
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [research, setResearch] = useState<ResearchDetail | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [reviews, setReviews] = useState<Array<Record<string, unknown>>>([]);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [earlyFinalizePending, setEarlyFinalizePending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [batchResponse, researchResponse, reviewResponse, readinessResponse] = await Promise.all([
        fetch(`/api/discovery/batches/${runId}`, { cache: "no-store" }),
        fetch(`/api/discovery/batches/${runId}/research`, { cache: "no-store" }),
        fetch(`/api/discovery/batches/${runId}/concept-reviews`, { cache: "no-store" }),
        fetch("/api/discovery/readiness", { cache: "no-store" }),
      ]);
      const [batchPayload, researchPayload, reviewPayload, readinessPayload] = await Promise.all([
        batchResponse.json().catch(() => null),
        researchResponse.json().catch(() => null),
        reviewResponse.json().catch(() => null),
        readinessResponse.json().catch(() => null),
      ]);
      if (!batchResponse.ok || !batchPayload?.ok) throw new Error(batchPayload?.error?.message ?? "Не удалось обновить поиск игры");
      setDetail(batchPayload.data as BatchDetail);
      if (researchResponse.ok && researchPayload?.ok) setResearch(researchPayload.data as ResearchDetail);
      if (reviewResponse.ok && reviewPayload?.ok) setReviews(array(reviewPayload.data?.reviews).map(object));
      if (readinessResponse.ok && readinessPayload?.ok) setReadiness(readinessPayload.data as Readiness);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось обновить этап 4.5");
    }
  }, [runId]);

  const refreshFromTrace = useCallback(async () => {
    try {
      const [batchResponse, researchResponse, reviewResponse] = await Promise.all([
        fetch(`/api/discovery/batches/${runId}`, { cache: "no-store" }),
        fetch(`/api/discovery/batches/${runId}/research`, { cache: "no-store" }),
        fetch(`/api/discovery/batches/${runId}/concept-reviews`, { cache: "no-store" }),
      ]);
      const [batchPayload, researchPayload, reviewPayload] = await Promise.all([
        batchResponse.json().catch(() => null),
        researchResponse.json().catch(() => null),
        reviewResponse.json().catch(() => null),
      ]);
      if (batchResponse.ok && batchPayload?.ok) setDetail(batchPayload.data as BatchDetail);
      if (researchResponse.ok && researchPayload?.ok) setResearch(researchPayload.data as ResearchDetail);
      if (reviewResponse.ok && reviewPayload?.ok) setReviews(array(reviewPayload.data?.reviews).map(object));
    } catch {
      // Поток событий продолжает нести прогресс; следующий durable-event или ручное обновление восстановит снимок.
    }
  }, [runId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const jobStatus = str(detail?.factoryJob?.status) ?? task.status;
  const currentStage = str(detail?.factoryJob?.current_stage);
  const progress = Math.max(0, Math.min(100, num(detail?.factoryJob?.progress) ?? task.progress ?? 0));
  const jobFailure = researchUserFacingFailure(detail?.factoryJob?.error);
  const frontStageActive = !currentStage || V2_FRONT_STAGES.has(currentStage);
  const durableState = object(detail?.factoryJob?.state);
  const earlyFinalize = object(durableState.research_early_finalize);
  const researchFinalization =
    str(durableState.research_finalization) ?? str(earlyFinalize.finalization) ?? "full";
  const canEarlyFinalize =
    currentStage === "waiting_research_scouts" &&
    earlyFinalize.eligible === true &&
    earlyFinalize.requested !== true;

  const concepts = useMemo(() => {
    const rootOutputs = object(detail?.root?.outputs);
    const conceptById = new Map(array(rootOutputs.discovery_concepts).map(object).map((concept) => [str(concept.conceptId), concept]));
    return (detail?.conceptRuns ?? []).flatMap((run) => {
      const outputs = object(run.outputs);
      const concept = object(outputs.coop_game_concept);
      const conceptId = str(concept.conceptId) ?? str(object(run.metadata).concept_id);
      const runIdValue = str(run.id);
      if (!conceptId || !runIdValue) return [];
      return [{ conceptRunId: runIdValue, conceptId, concept: Object.keys(concept).length ? concept : conceptById.get(conceptId) ?? {} }];
    });
  }, [detail]);

  const requestEarlyFinalize = useCallback(async () => {
    setEarlyFinalizePending(true);
    setError(null);
    try {
      const response = await fetch(`/api/discovery/batches/${runId}/early-finalize`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? "Не удалось ответить сейчас");
      }
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось ответить сейчас");
    } finally {
      setEarlyFinalizePending(false);
    }
  }, [load, runId]);

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
    try {
      const response = await fetch(`/api/discovery/batches/${runId}/concept-reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conceptRunId, conceptId, decision, feedback: note || null }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message ?? "Не удалось сохранить решение");
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
          <span className="font-semibold text-emerald-300">
            {researchFinalization === "early_finalized"
              ? "Исследование этапа 4.5 завершено досрочно: данных уже было достаточно."
              : "Исследование этапа 4.5 завершено."}
          </span>{" "}
          Дальше запускается проверенный медиаконвейер. Проверка изображения и проверка видео человеком остаются обязательными.
        </div>
        <DiscoveryTaskCard task={task} runId={runId} />
      </div>
    );
  }

  const scoutDone = (research?.scouts ?? []).filter((item) => str(item.status) === "completed").length;
  const designerDone = (research?.conceptDesigners ?? []).filter((item) => str(item.status) === "completed").length;
  const evidencePack = object(research?.evidencePack?.pack);
  const coverage = object(evidencePack.coverage);
  const researchStartedAt = str(research?.researchRun?.started_at) ?? str(research?.researchRun?.created_at);

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card/70 shadow-sm">
      <div className="space-y-3 border-b border-border bg-background/20 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-violet-400" />
              <p className="text-sm font-semibold text-foreground">Поиск игры · этап 4.5</p>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{stageLabel(currentStage)}</p>
          </div>
          <div className="flex items-center gap-2">
            {canEarlyFinalize && (
              <Button
                size="sm"
                variant="secondary"
                disabled={earlyFinalizePending}
                onClick={() => void requestEarlyFinalize()}
              >
                {earlyFinalizePending ? "Формирую ответ…" : "Ответить сейчас"}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void load()} aria-label="Обновить">
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${progress}%` }} />
        </div>
        <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
          <span>Исследователи: {scoutDone}/5</span>
          <span>Источники: {research?.sources.length ?? 0}</span>
          <span>Доказательства: {research?.evidence.length ?? 0}</span>
          <span>Дизайнеры концептов: {designerDone}/3</span>
          <span>Черновые варианты: {research?.rawCandidates.length ?? 0}</span>
        </div>
        {canEarlyFinalize && (
          <p className="text-[11px] text-violet-200">
            Данных уже достаточно: завершено исследователей — {String(earlyFinalize.completed_scouts ?? scoutDone)}, доказательств — {String(earlyFinalize.evidence_count ?? research?.evidence.length ?? 0)}. Можно остановить оставшееся исследование и перейти к итоговому анализу.
          </p>
        )}
      </div>

      {researchFinalization === "early_finalized" && (
        <div className="border-b border-violet-500/20 bg-violet-500/5 px-4 py-3 text-xs text-violet-200">
          Этот запуск завершён досрочно: оставшиеся исследователи были остановлены после достижения достаточного покрытия, а итоговый пакет собран из уже подтверждённых источников.
        </div>
      )}

      <ResearchLiveTrace
        runId={runId}
        startedAt={researchStartedAt}
        initialScouts={research?.scouts ?? []}
        onMaterialUpdate={() => { void refreshFromTrace(); }}
      />

      {readiness && !readiness.readyForManualV2Test && (
        <div className="flex gap-2 border-b border-amber-500/20 bg-amber-500/5 p-4 text-xs text-amber-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            Готовность production неполная: KIE={String(readiness.kieConfigured)}, поиск KIE={String(readiness.kieOnlySearchEnabled)}, Drive={String(readiness.googleDriveConfigured)}, тестовый режим={String(readiness.mockWorkflows)}. Эта проверка только смотрит конфигурацию и не выполняет платных запросов.
          </div>
        </div>
      )}

      {readiness?.readyForManualV2Test && (
        <div className="flex gap-2 border-b border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-200">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          Исследование через KIE и Google Drive настроены для ручного production-теста. Автоматический платный пробный запрос отключён.
        </div>
      )}

      {(research?.sources.length ?? 0) > 0 && (
        <details className="border-b border-border p-4">
          <summary className="cursor-pointer text-xs font-semibold text-foreground">Источники исследования и их происхождение</summary>
          <div className="mt-3 space-y-2">
            {research!.sources.slice(0, 12).map((source, index) => {
              const url = str(source.url);
              return (
                <div key={str(source.id) ?? `${index}`} className="flex items-start justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <p className="truncate text-foreground">{str(source.title) ?? url ?? "Источник"}</p>
                    <p className="text-[11px] text-muted-foreground">{roleLabel(str(source.scoutRole) ?? "research")}</p>
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
          <p className="font-semibold text-foreground">Покрытие пакета доказательств</p>
          <p className="mt-1">{Object.entries(coverage).map(([key, value]) => `${key}: ${String(value)}`).join(" · ")}</p>
        </div>
      )}

      {(research?.conceptDesigners.length ?? 0) > 0 && (
        <div className="grid gap-2 border-b border-border p-4 sm:grid-cols-3">
          {research!.conceptDesigners.map((designer) => {
            const role = str(designer.role) ?? "designer";
            const status = str(designer.status) ?? "queued";
            return (
              <div key={role} className="rounded-lg border border-border bg-background/30 p-3">
                <p className="text-xs font-semibold text-foreground">{roleLabel(role)}</p>
                <p className={`mt-1 text-[11px] ${statusTone(status)}`}>{statusLabel(status)}</p>
              </div>
            );
          })}
        </div>
      )}

      {currentStage === "human_concept_approval_pending" && concepts.length > 0 && (
        <div>
          <div className="flex items-center gap-2 border-b border-border bg-violet-500/5 px-4 py-3 text-xs text-violet-200">
            <AlertCircle className="h-4 w-4" />
            Проверка концептов человеком. Генерация изображений и видео заблокирована, пока вы не примете решения по концептам.
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
          Комментарий сохранён. Завод перерабатывает или заменяет отмеченные концепты и затем снова вернёт их на вашу проверку.
        </div>
      )}

      {jobStatus === "failed" && (
        <div className="border-t border-red-500/20 bg-red-500/5 p-4 text-xs text-red-200">
          <p>Этап 4.5 остановлен: {jobFailure.message}</p>
          {jobFailure.code && (
            <p className="mt-1 text-[11px] text-red-300/80">Код: {jobFailure.code}</p>
          )}
        </div>
      )}

      {!error && jobStatus !== "failed" && currentStage !== "human_concept_approval_pending" && currentStage !== "concept_revision_pending" && (
        <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
          {jobStatus === "completed" ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <Loader2 className="h-4 w-4 animate-spin text-amber-400" />}
          {stageLabel(currentStage)}
        </div>
      )}

      {error && <div className="border-t border-red-500/20 p-4 text-xs text-red-300">{error}</div>}
    </div>
  );
}
