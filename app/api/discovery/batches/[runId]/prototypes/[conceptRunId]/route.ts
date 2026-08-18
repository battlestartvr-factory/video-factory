import { getSessionUser } from "@/lib/auth/session";
import { getGameDiscoveryBatch } from "@/lib/game-discovery/service";
import {
  createDriveAuthClient,
  getDriveAccessToken,
} from "@/lib/storage/drive-provider";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM_TIMEOUT_MS = 60_000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string; conceptRunId: string }> },
) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { runId, conceptRunId } = await params;
  const root = await getGameDiscoveryBatch({ userId: user.id, runId });
  if (!root) return new Response("Not found", { status: 404 });

  const service = createSupabaseServiceClient();
  const { data: concept, error } = await service
    .from("creative_runs")
    .select("id,parent_run_id,metadata,outputs")
    .eq("id", conceptRunId)
    .eq("parent_run_id", root.id)
    .contains("metadata", { domain_kind: "coop_game_concept" })
    .maybeSingle();
  if (error || !concept) return new Response("Not found", { status: 404 });

  const assembly =
    concept.outputs && typeof concept.outputs === "object" && !Array.isArray(concept.outputs)
      ? (concept.outputs.prototype_assembly as Record<string, unknown> | undefined)
      : undefined;
  const driveFileId =
    assembly && typeof assembly.driveFileId === "string" ? assembly.driveFileId.trim() : "";
  if (!driveFileId) return new Response("Prototype not found", { status: 404 });

  const auth = createDriveAuthClient();
  if (!auth) return new Response("Prototype storage unavailable", { status: 503 });
  try {
    const token = await getDriveAccessToken(auth);
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFileId)}`);
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");
    const range = request.headers.get("range");
    const upstream = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "video/mp4,*/*",
        ...(range ? { Range: range } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!upstream.ok && upstream.status !== 206) {
      return new Response("Prototype unavailable", { status: 502 });
    }

    const headers = new Headers();
    for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("Content-Type", "video/mp4");
    headers.set("Cache-Control", "private, max-age=3600");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    console.error("discovery.prototype.stream_failed", {
      root_run_id: runId,
      concept_run_id: conceptRunId,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response("Prototype unavailable", { status: 502 });
  }
}
