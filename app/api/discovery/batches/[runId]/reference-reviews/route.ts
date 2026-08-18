import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { apiError, apiSuccess, readJsonBody } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import {
  listGameplayReferenceReviews,
  recordGameplayReferenceReview,
} from "@/lib/game-discovery/service";

const reviewSchema = z
  .object({
    conceptRunId: z.string().uuid(),
    generationId: z.string().uuid().nullable().optional(),
    conceptId: z.string().trim().min(1).max(160),
    momentId: z.string().trim().min(1).max(160),
    shotId: z.string().trim().min(1).max(160),
    decision: z.enum(["approve", "reject", "revise"]),
    feedback: z.string().trim().max(8_000).nullable().optional(),
  })
  .strict();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const requestId = generateRequestId();
  const { runId } = await params;
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  try {
    const reviews = await listGameplayReferenceReviews({ userId: user.id, rootRunId: runId });
    return apiSuccess({ reviews });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    if (message === "FORBIDDEN") return apiError("FORBIDDEN", "Нет доступа", 403, requestId);
    return apiError("FETCH_FAILED", "Не удалось загрузить отзывы по gameplay reference", 500, requestId);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const requestId = generateRequestId();
  const { runId } = await params;
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const body = await readJsonBody<unknown>(request);
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", "Некорректный отзыв по gameplay reference", 400, requestId);
  }

  if (parsed.data.decision !== "approve" && !parsed.data.feedback?.trim()) {
    return apiError(
      "FEEDBACK_REQUIRED",
      "Для revise/reject нужен комментарий, чтобы завод мог не повторять ошибку",
      400,
      requestId,
    );
  }

  try {
    const review = await recordGameplayReferenceReview({
      userId: user.id,
      rootRunId: runId,
      conceptRunId: parsed.data.conceptRunId,
      generationId: parsed.data.generationId ?? null,
      conceptId: parsed.data.conceptId,
      momentId: parsed.data.momentId,
      shotId: parsed.data.shotId,
      decision: parsed.data.decision,
      rawFeedback: parsed.data.feedback ?? null,
    });
    return apiSuccess({ review }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    if (message === "FORBIDDEN") return apiError("FORBIDDEN", "Нет доступа", 403, requestId);
    if (message === "CONCEPT_RUN_NOT_FOUND") {
      return apiError("NOT_FOUND", "Концепт не найден в этом discovery batch", 404, requestId);
    }
    if (message === "KIE_NOT_CONFIGURED") {
      return apiError("MODEL_UNAVAILABLE", "Экономичная модель для разбора feedback не настроена", 503, requestId);
    }
    return apiError("REVIEW_FAILED", "Не удалось сохранить отзыв по gameplay reference", 500, requestId);
  }
}
