import type { JobStatus } from "@/lib/types/database";

const VALID_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  draft: ["queued"],
  queued: ["processing", "cancelled", "failed"],
  processing: ["review", "completed", "cancelled", "failed"],
  review: ["processing", "completed", "cancelled"],
  failed: ["queued"],
  completed: [],
  cancelled: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid status transition: ${from} → ${to}`);
  }
}

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  draft: "Черновик",
  queued: "В очереди",
  processing: "Обработка",
  review: "На согласовании",
  completed: "Завершена",
  failed: "Ошибка",
  cancelled: "Отменена",
};

export const JOB_TYPE_LABELS: Record<string, string> = {
  script: "Сценарий",
  post: "Пост",
  image: "Изображение",
  short_video: "Короткое видео",
  dev_diary: "Dev diary",
};

export const JOB_MODE_LABELS: Record<string, string> = {
  economy: "Эконом",
  balanced: "Баланс",
  quality: "Качество",
};
