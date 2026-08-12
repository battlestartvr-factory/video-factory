import { apiError, apiSuccess } from "@/lib/api/response";
import { getFactoryJobForUser, requireFactoryUser } from "@/lib/factory/access";
import { generateRequestId } from "@/lib/logging/logger";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type {
  FactoryApproval,
  FactoryAsset,
  FactoryJobDetail,
  FactoryJobStageSummary,
  NormalizedFactoryError,
} from "@/lib/factory/contracts";
import type { UserRole } from "@/lib/types/database";

type RouteContext = { params: Promise<{ jobId: string }> };

function mapStage(row: Record<string, unknown>): FactoryJobStageSummary {
  return {
    id: row.id as string,
    stage: row.stage as string,
    status: row.status as FactoryJobStageSummary["status"],
    attempt: row.attempt as number,
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapAsset(row: Record<string, unknown>): FactoryAsset {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    stageId: (row.stage_id as string | null) ?? null,
    variantIndex: row.variant_index as number,
    kind: row.kind as FactoryAsset["kind"],
    storage: row.storage as FactoryAsset["storage"],
    sourceUrl: (row.source_url as string | null) ?? null,
    driveWebUrl: (row.drive_web_url as string | null) ?? null,
    textContent: (row.text_content as string | null) ?? null,
    mimeType: (row.mime_type as string | null) ?? null,
    sizeBytes: (row.size_bytes as number | null) ?? null,
    approved: row.approved as boolean,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapApproval(row: Record<string, unknown>): FactoryApproval {
  return {
    id: row.id as string,
    requestId: row.request_id as string,
    jobId: row.job_id as string,
    userId: row.user_id as string,
    stage: row.stage as string,
    decision: row.decision as FactoryApproval["decision"],
    comment: (row.comment as string | null) ?? null,
    selectedAssetId: (row.selected_asset_id as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export async function GET(_request: Request, context: RouteContext) {
  const requestId = generateRequestId();
  const { jobId } = await context.params;

  try {
    const auth = await requireFactoryUser();
    if (auth.error || !auth.user) {
      return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);
    }

    const jobResult = await getFactoryJobForUser(
      jobId,
      auth.user.id,
      auth.profile?.role as UserRole | undefined,
    );
    if (jobResult.error || !jobResult.job) {
      const status = jobResult.error === "FORBIDDEN" ? 403 : 404;
      const code = jobResult.error === "FORBIDDEN" ? "FORBIDDEN" : "NOT_FOUND";
      const message =
        jobResult.error === "FORBIDDEN" ? "Нет доступа к задаче" : "Задача не найдена";
      return apiError(code, message, status, requestId);
    }

    const supabase = await createSupabaseServerClient();
    const [detailRes, stagesRes, assetsRes, approvalsRes] = await Promise.all([
      supabase.from("factory_job_detail").select("*").eq("id", jobId).single(),
      supabase.from("factory_job_stages_safe").select("*").eq("job_id", jobId),
      supabase.from("factory_assets_safe").select("*").eq("job_id", jobId),
      supabase.from("factory_approvals").select("*").eq("job_id", jobId),
    ]);

    if (detailRes.error || !detailRes.data) {
      return apiError("NOT_FOUND", "Задача не найдена", 404, requestId);
    }

    const detail = detailRes.data;
    const payload: FactoryJobDetail = {
      id: detail.id,
      requestId: detail.request_id,
      projectId: detail.project_id,
      userId: detail.user_id,
      jobType: detail.job_type,
      preset: detail.preset,
      contentNamespace: detail.content_namespace,
      conceptDisclosureRequired: detail.concept_disclosure_required,
      status: detail.status,
      currentStage: detail.current_stage,
      progress: detail.progress,
      input: (detail.input as Record<string, unknown>) ?? {},
      result: (detail.result as Record<string, unknown>) ?? {},
      error: (detail.error as NormalizedFactoryError | null) ?? null,
      cancelRequested: detail.cancel_requested,
      estimatedCostUsd: detail.estimated_cost_usd,
      actualCostUsd: Number(detail.actual_cost_usd ?? 0),
      aggregatedActualCostUsd: Number(detail.aggregated_actual_cost_usd ?? 0),
      createdAt: detail.created_at,
      updatedAt: detail.updated_at,
      completedAt: detail.completed_at,
      stages: (stagesRes.data ?? []).map((row) => mapStage(row as Record<string, unknown>)),
      assets: (assetsRes.data ?? []).map((row) => mapAsset(row as Record<string, unknown>)),
      approvals: (approvalsRes.data ?? []).map((row) =>
        mapApproval(row as Record<string, unknown>),
      ),
    };

    return apiSuccess(payload);
  } catch {
    return apiError("INTERNAL_ERROR", "Внутренняя ошибка", 500, requestId);
  }
}
