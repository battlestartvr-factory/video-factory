import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createLogger } from "@/lib/logging/logger";
import { isMockWorkflowsEnabled } from "@/lib/env/mock-workflows";
import type { JobStatus } from "@/lib/types/database";

const MOCK_STAGES = [
  { progress: 10, stage: "Анализ исходника", status: "processing" as JobStatus },
  { progress: 35, stage: "Генерация сценария", status: "processing" as JobStatus },
  { progress: 60, stage: "Создание визуалов", status: "processing" as JobStatus },
  { progress: 85, stage: "Финальная сборка", status: "processing" as JobStatus },
  { progress: 100, stage: "Готово к проверке", status: "review" as JobStatus },
];

export async function runMockWorkflow(jobId: string): Promise<void> {
  if (!isMockWorkflowsEnabled()) return;

  const logger = createLogger({ jobId, event: "mock.workflow" });
  const supabase = createSupabaseServiceClient();

  for (const step of MOCK_STAGES) {
    await new Promise((r) => setTimeout(r, 1500));

    const { data: job } = await supabase
      .from("jobs")
      .select("status")
      .eq("id", jobId)
      .single();

    if (!job || job.status === "cancelled" || job.status === "failed") {
      logger.info("Mock workflow stopped", { status: job?.status });
      return;
    }

    await supabase
      .from("jobs")
      .update({
        status: step.status,
        progress: step.progress,
        current_stage: step.stage,
        started_at: step.progress === 10 ? new Date().toISOString() : undefined,
      })
      .eq("id", jobId);

    await supabase.from("job_events").insert({
      job_id: jobId,
      event_type: "mock.progress",
      status: step.status,
      message: step.stage,
      progress: step.progress,
      metadata: { mock: true },
    });

    if (step.progress === 60) {
      const { data: jobRow } = await supabase
        .from("jobs")
        .select("project_id")
        .eq("id", jobId)
        .single();

      if (jobRow) {
        await supabase.from("assets").upsert(
          {
            project_id: jobRow.project_id,
            job_id: jobId,
            kind: "text",
            provider: "mock",
            external_id: `mock-text-${jobId}`,
            url: null,
            mime_type: "text/plain",
            metadata: {
              preview: "Демо-сценарий: короткое видео о новой VR-локации Battle Start.",
            },
          },
          { onConflict: "job_id,kind,external_id", ignoreDuplicates: true },
        );
      }
    }
  }

  await supabase
    .from("jobs")
    .update({
      estimated_cost_usd: 0.42,
      actual_cost_usd: 0.38,
    })
    .eq("id", jobId);

  logger.info("Mock workflow completed");
}

export function scheduleMockWorkflow(jobId: string): void {
  void runMockWorkflow(jobId).catch((err) => {
    createLogger({ jobId }).error("Mock workflow error", {
      error: err instanceof Error ? err.message : "unknown",
    });
  });
}
