import { getSessionUser } from "@/lib/auth/session";
import { getGameDiscoveryBatch } from "@/lib/game-discovery/service";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const encoder = new TextEncoder();

function cursorFromRequest(request: Request): number {
  const header = request.headers.get("last-event-id")?.trim();
  const query = new URL(request.url).searchParams.get("after")?.trim();
  const value = Number(header || query || "0");
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function sse(input: { id?: number; event?: string; data?: unknown; comment?: string }): Uint8Array {
  if (input.comment) return encoder.encode(`: ${input.comment}\n\n`);
  const lines = [
    input.id !== undefined ? `id: ${input.id}` : null,
    input.event ? `event: ${input.event}` : null,
    `data: ${JSON.stringify(input.data ?? {})}`,
    "",
    "",
  ].filter((line): line is string => line !== null);
  return encoder.encode(lines.join("\n"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { runId } = await params;
  let root;
  try {
    root = await getGameDiscoveryBatch({ userId: user.id, runId });
  } catch {
    return new Response("Forbidden", { status: 403 });
  }
  if (!root) return new Response("Not found", { status: 404 });
  if (!root.factory_job_id) return new Response("Discovery job missing", { status: 409 });

  const rootJobId = root.factory_job_id;
  const service = createSupabaseServiceClient();
  let cursor = cursorFromRequest(request);
  let stopped = false;
  let lastKeepAlive = Date.now();
  let lastStatusCheck = 0;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (stopped) return;
        stopped = true;
        try {
          controller.close();
        } catch {
          // Client may have closed the stream already.
        }
      };
      request.signal.addEventListener("abort", close, { once: true });

      const run = async () => {
        try {
          controller.enqueue(encoder.encode("retry: 1000\n\n"));
          controller.enqueue(sse({ event: "ready", data: { after: cursor } }));

          while (!stopped) {
            const { data, error } = await service
              .from("research_progress_events")
              .select("sequence_id,event_type,job_id,research_run_id,scout_role,payload,created_at")
              .eq("root_factory_job_id", rootJobId)
              .gt("sequence_id", cursor)
              .order("sequence_id", { ascending: true })
              .limit(100);

            if (error) throw new Error("RESEARCH_TRACE_READ_FAILED");

            for (const row of data ?? []) {
              if (stopped) return;
              const sequenceId = Number(row.sequence_id);
              if (!Number.isSafeInteger(sequenceId) || sequenceId <= cursor) continue;
              cursor = sequenceId;
              controller.enqueue(sse({
                id: sequenceId,
                event: "trace",
                data: {
                  sequenceId,
                  eventType: row.event_type,
                  jobId: row.job_id,
                  researchRunId: row.research_run_id,
                  scoutRole: row.scout_role,
                  payload: row.payload ?? {},
                  createdAt: row.created_at,
                },
              }));
            }

            if ((data?.length ?? 0) >= 100) continue;

            const now = Date.now();
            if (now - lastStatusCheck >= 5_000) {
              lastStatusCheck = now;
              const { data: job } = await service
                .from("factory_jobs")
                .select("status,current_stage,progress,updated_at")
                .eq("id", rootJobId)
                .maybeSingle();
              if (job && TERMINAL.has(String(job.status))) {
                controller.enqueue(sse({
                  event: "done",
                  data: {
                    status: job.status,
                    currentStage: job.current_stage,
                    progress: job.progress,
                    updatedAt: job.updated_at,
                  },
                }));
                close();
                return;
              }
            }

            if (now - lastKeepAlive >= 15_000) {
              lastKeepAlive = now;
              controller.enqueue(sse({ comment: "keep-alive" }));
            }
            await sleep(750);
          }
        } catch {
          if (!stopped) {
            try {
              controller.enqueue(sse({ event: "trace_error", data: { code: "RESEARCH_TRACE_UNAVAILABLE" } }));
            } finally {
              close();
            }
          }
        }
      };

      void run();
    },
    cancel() {
      stopped = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
