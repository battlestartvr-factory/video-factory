import { getSessionUser } from "@/lib/auth/session";
import { apiError, apiSuccess } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import { getGameDiscoveryBatchDetail } from "@/lib/game-discovery/service";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function humanFacingGameplayCaption(run: Record<string, unknown>): string {
  const outputs = object(run.outputs);
  const moment = object(outputs.gameplay_moment);
  const metadata = object(moment.metadata);
  return str(metadata.humanFacingSummaryRu)
    ?? "Игровой момент: игроки выполняют взаимозависимые действия, а их результат виден прямо в игре.";
}

function localizeGameplayCaptions<T extends { conceptRuns: Array<Record<string, unknown>> }>(detail: T): T {
  return {
    ...detail,
    conceptRuns: detail.conceptRuns.map((run) => {
      const outputs = object(run.outputs);
      const shot = object(outputs.gameplay_shot);
      if (!Object.keys(shot).length) return run;
      return {
        ...run,
        outputs: {
          ...outputs,
          gameplay_shot: {
            ...shot,
            // UI projection only: durable canonical shot.action remains untouched in storage.
            action: humanFacingGameplayCaption(run),
          },
        },
      };
    }),
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const requestId = generateRequestId();
  const { runId } = await params;
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  try {
    const detail = await getGameDiscoveryBatchDetail({ userId: user.id, runId });
    if (!detail) return apiError("NOT_FOUND", "Discovery batch не найден", 404, requestId);
    return apiSuccess(localizeGameplayCaptions(detail));
  } catch {
    return apiError("FETCH_FAILED", "Не удалось загрузить детали discovery batch", 500, requestId);
  }
}
