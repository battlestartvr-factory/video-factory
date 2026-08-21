"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ExternalLink, Search } from "lucide-react";

interface ResearchLiveTraceProps {
  runId: string;
  startedAt?: string | null;
  initialScouts?: Array<Record<string, unknown>>;
  onMaterialUpdate?: () => void;
}

interface TraceEvent {
  sequenceId: number;
  eventType: string;
  jobId: string | null;
  researchRunId: string | null;
  scoutRole: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

const MATERIAL_EVENTS = new Set([
  "research.evidence.persisted",
  "research.scout.persisted",
  "research.scout.completed",
  "research.synthesis.completed",
  "concept.curation.completed",
  "concept.council.completed",
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

function roleLabel(role: string | null): string {
  if (!role) return "Исследователь";
  const labels: Record<string, string> = {
    mechanics_explorer: "Исследователь механик",
    mechanic_scout: "Исследователь механик",
    market_scout: "Исследователь рынка",
    competitor_scout: "Исследователь конкурентов",
    player_sentiment_scout: "Исследователь отзывов игроков",
    visual_scout: "Исследователь визуальных референсов",
    social_viral_designer: "Дизайнер социальных моментов",
    buildable_systems_designer: "Дизайнер реализуемых систем",
  };
  return labels[role] ?? role.replaceAll("_", " ");
}

function announceRun(runId: string, active: boolean): void {
  window.dispatchEvent(new CustomEvent("game-discovery-v2-activity", {
    detail: { runId, active },
  }));
}

function parseTrace(value: unknown): TraceEvent | null {
  const row = object(value);
  const sequenceId = num(row.sequenceId);
  const eventType = str(row.eventType);
  const createdAt = str(row.createdAt);
  if (sequenceId === null || !eventType || !createdAt) return null;
  return {
    sequenceId,
    eventType,
    jobId: str(row.jobId),
    researchRunId: str(row.researchRunId),
    scoutRole: str(row.scoutRole),
    payload: object(row.payload),
    createdAt,
  };
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatActivity(value: string | null, now: number): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 5) return "только что";
  if (seconds < 60) return `${seconds} сек назад`;
  return `${Math.floor(seconds / 60)} мин назад`;
}

function eventLabel(event: TraceEvent): string {
  const role = roleLabel(event.scoutRole);
  switch (event.eventType) {
    case "research.scout.started": return `${role}: старт`;
    case "research.search.started": return `${role}: поиск KIE/Google`;
    case "research.search.completed": return `${role}: поиск завершён`;
    case "research.source.fetch_started": return `${role}: безопасная загрузка источника`;
    case "research.source.accepted": return `${role}: источник принят`;
    case "research.source.rejected": return `${role}: источник отклонён`;
    case "research.evidence.extracted": return `${role}: доказательство извлечено`;
    case "research.evidence.persisted": return `${role}: доказательство сохранено`;
    case "research.scout.persisted": return `${role}: отчёт сохранён`;
    case "research.scout.completed": return `${role}: завершён`;
    case "research.scouts_waiting": return "Координатор исследования ждёт исследователей";
    case "research.synthesis.started": return "Итоговый анализ исследования запущен";
    case "research.synthesis.completed": return "Пакет доказательств готов";
    case "concept.curation.completed": return "Концепции готовы";
    case "concept.council.completed": return "Создание концепций завершено";
    case "job.cancelled": return "Исследование остановлено пользователем";
    default: return event.eventType.replaceAll("_", " ");
  }
}

function scoutState(events: TraceEvent[], role: string, fallback: string): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.scoutRole !== role) continue;
    if (event.eventType === "research.scout.completed" || event.eventType === "research.scout.persisted") return "завершён";
    if (event.eventType === "research.evidence.persisted" || event.eventType === "research.evidence.extracted") return "собирает доказательства";
    if (event.eventType === "research.source.fetch_started") return "читает источники";
    if (event.eventType === "research.search.started") return "ищет";
    if (event.eventType === "research.scout.started") return "работает";
  }
  const normalized = fallback.toLowerCase();
  if (normalized === "queued") return "в очереди";
  if (normalized === "waiting") return "ожидает";
  if (normalized === "running") return "работает";
  if (normalized === "completed") return "завершён";
  if (normalized === "failed") return "ошибка";
  if (normalized === "cancelled") return "отменён";
  return fallback;
}

export function ResearchLiveTrace({
  runId,
  startedAt,
  initialScouts = [],
  onMaterialUpdate,
}: ResearchLiveTraceProps) {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [connection, setConnection] = useState<"connecting" | "live" | "reconnecting" | "done">("connecting");
  const [now, setNow] = useState(() => Date.now());
  const materialUpdateRef = useRef(onMaterialUpdate);
  const refreshTimerRef = useRef<number | null>(null);
  const doneRefreshTimersRef = useRef<number[]>([]);

  useEffect(() => {
    materialUpdateRef.current = onMaterialUpdate;
  }, [onMaterialUpdate]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const source = new EventSource(`/api/discovery/batches/${runId}/trace`);

    const scheduleMaterialRefresh = () => {
      if (!materialUpdateRef.current || refreshTimerRef.current !== null) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        materialUpdateRef.current?.();
      }, 400);
    };

    const scheduleDoneReconciliation = () => {
      // Concept persistence and the final human-gate transition can commit a fraction after
      // the last trace event. Re-read the durable snapshot a few times so the gate appears
      // without requiring a manual browser refresh.
      for (const delay of [450, 1_500, 3_500]) {
        const timer = window.setTimeout(() => materialUpdateRef.current?.(), delay);
        doneRefreshTimersRef.current.push(timer);
      }
    };

    const onReady = () => {
      setConnection("live");
      announceRun(runId, true);
    };
    const onTrace = (message: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        return;
      }
      const event = parseTrace(parsed);
      if (!event) return;
      setConnection("live");
      setEvents((current) => {
        if (current.some((item) => item.sequenceId === event.sequenceId)) return current;
        const next = [...current, event].sort((a, b) => a.sequenceId - b.sequenceId);
        return next.length > 200 ? next.slice(next.length - 200) : next;
      });
      if (event.eventType === "job.cancelled") announceRun(runId, false);
      if (
        MATERIAL_EVENTS.has(event.eventType) ||
        event.eventType.startsWith("concept.") ||
        event.eventType === "job.cancelled"
      ) {
        scheduleMaterialRefresh();
      }
    };
    const onDone = () => {
      setConnection("done");
      announceRun(runId, false);
      scheduleDoneReconciliation();
      source.close();
    };
    const onError = () => setConnection((current) => current === "done" ? "done" : "reconnecting");

    source.addEventListener("ready", onReady);
    source.addEventListener("trace", onTrace as EventListener);
    source.addEventListener("done", onDone);
    source.onerror = onError;

    return () => {
      source.close();
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      for (const timer of doneRefreshTimersRef.current) window.clearTimeout(timer);
      doneRefreshTimersRef.current = [];
    };
  }, [runId]);

  const lastEvent = events.at(-1) ?? null;
  const effectiveStartedAt = startedAt ?? events[0]?.createdAt ?? null;
  const startedMs = effectiveStartedAt ? Date.parse(effectiveStartedAt) : Number.NaN;
  const elapsed = Number.isFinite(startedMs) ? formatDuration(now - startedMs) : "—";

  const sources = useMemo(() => {
    const byUrl = new Map<string, { title: string; url: string; role: string | null }>();
    for (const event of events) {
      if (event.eventType !== "research.source.accepted") continue;
      const url = str(event.payload.url);
      if (!url) continue;
      byUrl.set(url, {
        title: str(event.payload.title) ?? url,
        url,
        role: event.scoutRole,
      });
    }
    return [...byUrl.values()].slice(-12).reverse();
  }, [events]);

  const evidence = useMemo(() => {
    const rows: Array<{ key: string; claim: string; subject: string | null; role: string | null }> = [];
    for (const event of events) {
      if (event.eventType !== "research.evidence.persisted" && event.eventType !== "research.evidence.extracted") continue;
      for (const [index, raw] of array(event.payload.items).entries()) {
        const item = object(raw);
        const claim = str(item.claim);
        if (!claim) continue;
        rows.push({
          key: str(item.id) ?? str(item.evidence_ref) ?? `${event.sequenceId}:${index}`,
          claim,
          subject: str(item.subject),
          role: event.scoutRole,
        });
      }
    }
    const unique = new Map<string, (typeof rows)[number]>();
    for (const row of rows) unique.set(row.key, row);
    return [...unique.values()].slice(-10).reverse();
  }, [events]);

  const scouts = useMemo(() => {
    return initialScouts.map((row) => {
      const role = str(row.role) ?? "исследователь";
      const fallback = str(row.status) ?? "queued";
      return { role, state: scoutState(events, role, fallback) };
    });
  }, [events, initialScouts]);

  const connectionLabel = connection === "live"
    ? "в эфире"
    : connection === "done"
      ? "завершён"
      : connection === "reconnecting"
        ? "переподключение"
        : "подключение";

  return (
    <div className="border-b border-border bg-background/10 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <Activity className="h-4 w-4 text-violet-400" />
          Ход исследования
          <span className={connection === "live" ? "text-emerald-400" : connection === "done" ? "text-muted-foreground" : "text-amber-400"}>
            · {connectionLabel}
          </span>
        </div>
        <div className="flex gap-3 text-[11px] text-muted-foreground">
          <span>прошло {elapsed}</span>
          <span>последняя активность {formatActivity(lastEvent?.createdAt ?? null, now)}</span>
        </div>
      </div>

      {scouts.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {scouts.map((scout) => (
            <div key={scout.role} className="rounded-lg border border-border bg-background/30 px-2.5 py-2">
              <p className="truncate text-[11px] font-semibold text-foreground">{roleLabel(scout.role)}</p>
              <p className="mt-1 text-[11px] text-violet-300">{scout.state}</p>
            </div>
          ))}
        </div>
      )}

      {lastEvent && (
        <div className="mt-3 rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-2 text-xs text-violet-100">
          <Search className="mr-2 inline h-3.5 w-3.5" />
          {eventLabel(lastEvent)}
        </div>
      )}

      {sources.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold text-foreground">Источники · {sources.length}</summary>
          <div className="mt-2 space-y-1.5">
            {sources.map((source) => (
              <div key={source.url} className="flex items-start justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <p className="truncate text-foreground">{source.title}</p>
                  <p className="text-[11px] text-muted-foreground">{source.role ? roleLabel(source.role) : "исследование"}</p>
                </div>
                <a href={source.url} target="_blank" rel="noreferrer" className="shrink-0 text-violet-300 hover:text-violet-200">
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
            ))}
          </div>
        </details>
      )}

      {evidence.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold text-foreground">Доказательства · {evidence.length}</summary>
          <div className="mt-2 space-y-2">
            {evidence.map((item) => (
              <div key={item.key} className="rounded-lg border border-border bg-background/30 px-3 py-2 text-xs">
                <p className="text-foreground">{item.claim}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {[item.role ? roleLabel(item.role) : null, item.subject].filter(Boolean).join(" · ")}
                </p>
              </div>
            ))}
          </div>
        </details>
      )}

      {events.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">История событий · {events.length}</summary>
          <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
            {events.slice(-12).reverse().map((event) => (
              <div key={event.sequenceId} className="flex justify-between gap-3">
                <span className="truncate">{eventLabel(event)}</span>
                <span className="shrink-0">#{event.sequenceId}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
