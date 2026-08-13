import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { apiSuccess, apiError } from "@/lib/api/response";
import { checkRateLimit } from "@/lib/api/rate-limit";
import { n8nJobUpdateSchema } from "@/lib/validation/schemas";
import { verifyHmacSignature, verifyTimestamp } from "@/lib/n8n/hmac";
import { assertTransition } from "@/lib/jobs/status-transitions";
import { isMockWorkflowsEnabled } from "@/lib/env/mock-workflows";
import { serverEnv } from "@/lib/env/env.server";
import { generateRequestId, createLogger } from "@/lib/logging/logger";
import type { JobStatus } from "@/lib/types/database";

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const logger = createLogger({ requestId, event: "webhook.n8n" });

  const rate = checkRateLimit("webhook:n8n", 100, 60_000);
  if (!rate.allowed) {
    return apiError("RATE_LIMITED", "Too many requests", 429, requestId);
  }

  const rawBody = await request.text();
  const signature = request.headers.get("X-Webhook-Signature");
  const timestamp = request.headers.get("X-Webhook-Timestamp");

  if (!isMockWorkflowsEnabled()) {
    if (!serverEnv.N8N_WEBHOOK_SECRET) {
      return apiError("NOT_CONFIGURED", "Webhook secret not configured", 503, requestId);
    }
    if (!verifyTimestamp(timestamp)) {
      return apiError("INVALID_TIMESTAMP", "Timestamp out of range", 401, requestId);
    }
    if (!verifyHmacSignature(rawBody, signature, serverEnv.N8N_WEBHOOK_SECRET)) {
      return apiError("INVALID_SIGNATURE", "Invalid signature", 401, requestId);
    }
  }

  let payload;
  try {
    payload = n8nJobUpdateSchema.parse(JSON.parse(rawBody));
  } catch {
    return apiError("VALIDATION_ERROR", "Invalid payload", 400, requestId);
  }

  const supabase = createSupabaseServiceClient();

  const { data: existingEvent } = await supabase
    .from("processed_webhook_events")
    .select("event_id")
    .eq("event_id", payload.eventId)
    .maybeSingle();

  if (existingEvent) {
    logger.info("Duplicate event ignored", { eventId: payload.eventId });
    return apiSuccess({ duplicate: true });
  }

  const { data: job } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", payload.jobId)
    .single();

  if (!job) {
    return apiError("NOT_FOUND", "Job not found", 404, requestId);
  }

  const currentStatus = job.status as JobStatus;
  const newStatus = payload.status as JobStatus;

  try {
    if (currentStatus !== newStatus) {
      assertTransition(currentStatus, newStatus);
    }
  } catch {
    return apiError("INVALID_TRANSITION", `Cannot transition ${currentStatus} → ${newStatus}`, 400, requestId);
  }

  const updates: Record<string, unknown> = {
    status: newStatus,
    progress: payload.progress ?? job.progress,
    current_stage: payload.stage ?? job.current_stage,
    n8n_execution_id: payload.n8nExecutionId ?? job.n8n_execution_id,
  };

  if (payload.error) {
    updates.error_code = payload.error.code;
    updates.error_message = payload.error.message;
  }

  if (newStatus === "completed") {
    updates.completed_at = payload.occurredAt;
    updates.progress = 100;
  }

  if (newStatus === "processing" && !job.started_at) {
    updates.started_at = payload.occurredAt;
  }

  await supabase.from("jobs").update(updates).eq("id", payload.jobId);

  await supabase.from("job_events").insert({
    job_id: payload.jobId,
    event_type: payload.event,
    status: newStatus,
    message: payload.message ?? payload.stage,
    progress: payload.progress,
    metadata: { eventId: payload.eventId },
  });

  for (const asset of payload.assets ?? []) {
    await supabase.from("assets").upsert(
      {
        project_id: job.project_id,
        job_id: payload.jobId,
        kind: asset.kind,
        provider: asset.provider,
        external_id: asset.externalId,
        url: asset.url,
        mime_type: asset.mimeType,
        size_bytes: asset.sizeBytes,
        metadata: asset.metadata,
      },
      { onConflict: "job_id,kind,external_id", ignoreDuplicates: false },
    );
  }

  for (const usage of payload.usage ?? []) {
    await supabase.from("usage_records").insert({
      job_id: payload.jobId,
      provider: usage.provider,
      model: usage.model,
      operation: usage.operation,
      input_units: usage.inputUnits,
      output_units: usage.outputUnits,
      cost_usd: usage.costUsd,
      metadata: usage.metadata,
    });
  }

  if (payload.usage?.length) {
    const totalCost = payload.usage.reduce((sum, u) => sum + u.costUsd, 0);
    await supabase
      .from("jobs")
      .update({ actual_cost_usd: totalCost })
      .eq("id", payload.jobId);
  }

  await supabase.from("processed_webhook_events").insert({
    event_id: payload.eventId,
    job_id: payload.jobId,
  });

  logger.info("Webhook processed", { jobId: payload.jobId, status: newStatus });
  return apiSuccess({ jobId: payload.jobId, status: newStatus });
}
