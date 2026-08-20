import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { apiError, apiSuccess, readJsonBody } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import {
  listGameplayConceptReviews,
  recordGameplayConceptReview,
} from "@/lib/game-discovery/concept-review-service";

const reviewSchema = z
  .object({
    conceptRunId: z.string().uuid(),
    conceptId: z.string().trim().min(1).max(160),
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
    const reviews = await listGameplayConceptReviews({ userId: user.id, rootRunId: runId });
    return apiSuccess({ reviews });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    if (message === "FORBIDDEN") return apiError("FORBIDDEN", "Нет доступа", 403, requestId);
    return apiError("FETCH_FAILED", "Не удалось загрузить решения по концептам", 500, requestId);
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
    return apiError("VALIDATION_ERROR", "Некорректное решение по концепту", 400, requestId);
  }

  if (parsed.data.decision !== "approve" && !parsed.data.feedback?.trim()) {
    return apiError(
      "FEEDBACK_REQUIRED",
      "Для исправления или отклонения идеи нужен комментарий",
      400,
      requestId,
    );
  }

  try {
    const review = await recordGameplayConceptReview({
      userId: user.id,
      rootRunId: runId,
      conceptRunId: parsed.data.conceptRunId,
      conceptId: parsed.data.conceptId,
      decision: parsed.data.decision,
      rawFeedback: parsed.data.feedback ?? null,
    });
    return apiSuccess({ review }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    if (message === "FORBIDDEN") return apiError("FORBIDDEN", "Нет доступа", 403, requestId);
    if (message === "FEEDBACK_REQUIRED") {
      return apiError("FEEDBACK_REQUIRED", "Для исправления или отклонения идеи нужен комментарий", 400, requestId);
    }
    return apiError("REVIEW_FAILED", "Не удалось сохранить решение по концепту", 500, requestId);
  }
}
