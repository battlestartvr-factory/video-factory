"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TaskCardData } from "@/lib/types/workspace";
import { ConceptReviewPanel, type ConceptReviewDecision } from "@/components/discovery/concept-review-panel";
import { DiscoveryTaskCard } from "./discovery-task-card";

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

const POLL_MS = 5_000;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
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
    research_planning: "Research Director планирует поиск",
    research_fanout: "Запуск 5 Research Scouts",
    waiting_research_scouts: "5 Research Scouts изучают рынок и механики",
    research_synthesis: "Research Synthesizer собирает Evidence Pack",
    concept_council_fanout: "Запуск 3 Concept Designers",
    waiting_concept_council: "Concept Council создаёт grounded hypotheses",
    concept_curation: "Curator выбирает 6 механически разных игр",
    human_concept_approval_pending: "Human Gate 1/3 — выберите игровые концепты",
    concept_revision_pending: "Concept Council применяет ваш feedback",
  };
  return stage ? labels[stage] ?? stage : "Stage 4.5 запускается";
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
      if (!batchResponse.ok || !batchPayload?.ok) throw new Error(batchPayload?.error?.message ?? "Не удалось обновить Game Discovery v2");
      setDetail(batchPayload.data as BatchDetail);
      if (researchResponse.ok && researchPayload?.ok) setResearch(researchPayload.data as ResearchDetail);
      if (reviewResponse.ok && reviewPayload?.ok) setReviews(array(reviewPayload.data?.reviews).map(object));
      if (readinessResponse.ok && readinessPayload?.ok) setReadiness(readinessPayload.data as Readiness);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось обновить Stage 4.5");
    }
  }, [runId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const jobStatus = str(detail?.factoryJob?.status) ?? task.status;
  const currentStage = str(detail?.factoryJob?.current_stage);
  const progress = Math.max(0, Math.min(100, num(detail?.factoryJob?.progress) ?? task.progress ?? 0));
  const frontStageActive = !currentStage || V2_FRONT_STAGES.has(currentStage);

  useEffect(() => {
    if (TERMINAL.has(jobStatus) || currentStage === "human_concept_approval_pending") return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [currentStage, jobStatus, load]);

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

  const submitConceptDecision = useCallback(async (
    conceptRunId: string,
    conceptId: string,
    decision: ConceptReviewDecision,
  ) => {
    const note = (feedback[conceptId] ?? "").trim();
    if (decision !== "approve" && !note) {
      setError("Для Исправить / Отклонить нужен комментарий.");
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
          <span className="font-semibold text-emerald-300">Stage 4.5 research завершён.</span>{" "}
          Дальше используется проверенный Stage 4 media pipeline. Human Gate 2/3 и 3/3 остаются обязательными.
        </div>
        <DiscoveryTaskCard task={task} runId={runId} />
      </div>
    );
  }

  const scoutDone = (research?.scouts ?? []).filter((item) => str(item.status) === "completed").length;
  const designerDone = (research?.conceptDesigners ?? []).filter((item) => str(item.status) === "completed").length;
  const evidencePack = object(research?.evidencePack?.pack);
  const coverage = object(evidencePack.coverage);

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card/70 shadow-sm">
      <div className="space-y-3 border-b border-border bg-background/20 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-violet-400" />
              <p className="text-sm font-semibold text-foreground">Game Discovery v2 · Stage 4.5</p>
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
          <span>Research Scouts: {scoutDone}/5</span>
          <span>Sources: {research?.sources.length ?? 0}</span>
          <span>Evidence: {research?.evidence.length ?? 0}</span>
          <span>Concept Designers: {designerDone}/3</span>
          <span>Raw candidates: {research?.rawCandidates.length ?? 0}</span>
        </div>
      </div>

      {readiness && !readiness.readyForManualV2Test && (
        <div className="flex gap-2 border-b border-amber-500/20 bg-amber-500/5 p-4 text-xs text-amber-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            Production readiness неполный: KIE={String(readiness.kieConfigured)}, KIE Search={String(readiness.kieOnlySearchEnabled)}, Drive={String(readiness.googleDriveConfigured)}, mock={String(readiness.mockWorkflows)}. Проверка конфигурационная — платных запросов не выполняет.
          </div>
        </div>
      )}

      {readiness?.readyForManualV2Test && (
        <div className="flex gap-2 border-b border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-200">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          KIE-only research и Drive настроены для ручного production-теста. Автоматический paid probe отключён.
        </div>
      )}

      {(research?.scouts.length ?? 0) > 0 && (
        <div className="grid gap-2 border-b border-border p-4 sm:grid-cols-2 lg:grid-cols-5">
          {research!.scouts.map((scout) => {
            const role = str(scout.role) ?? "scout";
            const status = str(scout.status) ?? "queued";
            return (
              <div key={role} className="rounded-lg border border-border bg-background/30 p-2.5">
                <p className="truncate text-[11px] font-semibold text-foreground">{role.replaceAll("_", " ")}</p>
                <p className={`mt-1 text-[11px] ${statusTone(status)}`}>{status}</p>
              </div>
            );
          })}
        </div>
      )}

      {(research?.sources.length ?? 0) > 0 && (
        <details className="border-b border-border p-4">
          <summary className="cursor-pointer text-xs font-semibold text-foreground">Research sources и provenance</summary>
          <div className="mt-3 space-y-2">
            {research!.sources.slice(0, 12).map((source, index) => {
              const url = str(source.url);
              return (
                <div key={str(source.id) ?? `${index}`} className="flex items-start justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <p className="truncate text-foreground">{str(source.title) ?? url ?? "Source"}</p>
                    <p className="text-[11px] text-muted-foreground">{str(source.scoutRole)?.replaceAll("_", " ") ?? "research"}</p>
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
          <p className="font-semibold text-foreground">Evidence Pack coverage</p>
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
                <p className="text-xs font-semibold text-foreground">{role.replaceAll("_", " ")}</p>
                <p className={`mt-1 text-[11px] ${statusTone(status)}`}>{status}</p>
              </div>
            );
          })}
        </div>
      )}

      {currentStage === "human_concept_approval_pending" && concepts.length > 0 && (
        <div>
          <div className="flex items-center gap-2 border-b border-border bg-violet-500/5 px-4 py-3 text-xs text-violet-200">
            <AlertCircle className="h-4 w-4" />
            Human Gate 1/3. Media generation заблокирован, пока вы не примете решения по концептам.
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
          Feedback сохранён. Завод обязан заменить отклонённые концепты механически новыми и снова вернётся к Human Concept Gate.
        </div>
      )}

      {jobStatus === "failed" && (
        <div className="border-t border-red-500/20 bg-red-500/5 p-4 text-xs text-red-200">
          Stage 4.5 остановлен: {str(detail?.factoryJob?.error && object(detail.factoryJob.error).message) ?? "см. job error"}
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
