"use client";

import { Loader2, CheckCircle2, XCircle, Clock, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TaskCardData } from "@/lib/types/workspace";
import { DiscoveryTaskCard } from "./discovery-task-card";
import { DiscoveryV2TaskCard } from "./discovery-v2-task-card";
import { DiscoveryV3TaskCard } from "./discovery-v3-task-card";

const STATUS_CONFIG: Record<string, { label: string; icon: typeof Clock; color: string }> = {
  queued: { label: "В очереди", icon: Clock, color: "text-zinc-400" },
  submitted: { label: "Отправлено", icon: Clock, color: "text-blue-400" },
  processing: { label: "Обработка", icon: Loader2, color: "text-amber-400" },
  running: { label: "Выполняется", icon: Loader2, color: "text-amber-400" },
  review: { label: "На согласовании", icon: AlertCircle, color: "text-violet-400" },
  awaiting_approval: { label: "На согласовании", icon: AlertCircle, color: "text-violet-400" },
  completed: { label: "Завершено", icon: CheckCircle2, color: "text-emerald-400" },
  succeeded: { label: "Завершено", icon: CheckCircle2, color: "text-emerald-400" },
  failed: { label: "Ошибка", icon: XCircle, color: "text-red-400" },
  cancelled: { label: "Отменено", icon: XCircle, color: "text-zinc-500" },
};

interface TaskCardProps {
  task: TaskCardData;
}

export function TaskCard({ task }: TaskCardProps) {
  const discoveryRunId =
    task.action === "game_discovery" && typeof task.settings?.runId === "string"
      ? task.settings.runId
      : null;
  if (discoveryRunId) {
    const workflowVersion = Number(task.settings?.workflowVersion ?? 1);
    if (workflowVersion === 3) {
      return <DiscoveryV3TaskCard task={task} runId={discoveryRunId} />;
    }
    if (workflowVersion === 2) {
      return <DiscoveryV2TaskCard task={task} runId={discoveryRunId} />;
    }
    return <DiscoveryTaskCard task={task} runId={discoveryRunId} />;
  }

  const config = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.queued;
  const Icon = config.icon;
  const isSpinning = ["processing", "running"].includes(task.status);

  return (
    <div className="mt-3 rounded-xl border border-border bg-surface-elevated p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">
            {task.action === "generate_video" ? "Генерация видео" :
             task.action === "generate_image" ? "Генерация изображения" :
             task.action}
          </p>
          {task.model && (
            <p className="mt-1 text-xs text-muted-foreground">Модель: {task.model}</p>
          )}
        </div>
        <span className={cn("flex items-center gap-1.5 text-xs font-medium", config.color)}>
          <Icon className={cn("h-3.5 w-3.5", isSpinning && "animate-spin")} />
          {config.label}
        </span>
      </div>

      {task.prompt && (
        <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{task.prompt}</p>
      )}

      {task.progress !== undefined && task.progress > 0 && (
        <div className="mt-3">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Прогресс</span>
            <span>{task.progress}%</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border">
            <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${task.progress}%` }} />
          </div>
        </div>
      )}

      {task.outputs && task.outputs.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {task.outputs.map((output, i) => (
            <div key={i} className="reference-placeholder aspect-video rounded-lg" />
          ))}
        </div>
      )}
    </div>
  );
}