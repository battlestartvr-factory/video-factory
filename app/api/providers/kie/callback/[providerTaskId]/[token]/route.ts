import { NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function extractExternalTaskId(payload: Record<string, unknown>): string | null {
  const data = asObject(payload.data);
  for (const value of [data.taskId, payload.taskId]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ providerTaskId: string; token: string }> },
) {
  const { providerTaskId, token } = await context.params;
  if (!providerTaskId || !token) {
    return NextResponse.json({ error: "invalid_callback_path" }, { status: 404 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = asObject(await request.json());
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const externalTaskId = extractExternalTaskId(payload);
  if (!externalTaskId) {
    return NextResponse.json({ error: "missing_task_id" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseServiceClient();
    const { data, error } = await supabase.rpc("orchestrator_record_provider_callback", {
      p_provider_task_id: providerTaskId,
      p_callback_token: token,
      p_external_task_id: externalTaskId,
      p_callback_payload: payload,
      p_trace_id: crypto.randomUUID(),
    });

    if (error) {
      // Invalid correlation tokens intentionally look like a generic rejected callback.
      console.warn("kie.callback.rejected", {
        provider_task_id: providerTaskId,
        code: error.code,
        message: error.message,
      });
      return NextResponse.json({ error: "callback_rejected" }, { status: 403 });
    }

    return NextResponse.json({ accepted: true, reconciliation: data }, { status: 202 });
  } catch (error) {
    console.error("kie.callback.failed", {
      provider_task_id: providerTaskId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "callback_unavailable" }, { status: 503 });
  }
}
