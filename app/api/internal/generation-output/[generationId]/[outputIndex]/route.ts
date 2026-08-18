import { verifyIngestBearerToken } from "@/lib/asset-ingest/auth";
import {
  createDriveAuthClient,
  getDriveAccessToken,
} from "@/lib/storage/drive-provider";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { resolveSupabaseServiceRoleKey } from "@/lib/supabase/service-config";
import { validateWebFetchUrl } from "@/lib/web/url-safety";
import type { GenerationOutput } from "@/lib/types/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_REDIRECTS = 4;
const UPSTREAM_TIMEOUT_MS = 2 * 60_000;

async function fetchProviderOutput(rawUrl: string): Promise<Response> {
  let current = await validateWebFetchUrl(rawUrl);
  if (current.protocol !== "https:") throw new Error("generation_output_requires_https");

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "*/*", "User-Agent": "AI-Content-Factory/1.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new Error("generation_output_redirect_failed");
      }
      current = await validateWebFetchUrl(new URL(location, current).toString());
      if (current.protocol !== "https:") throw new Error("generation_output_requires_https");
      continue;
    }
    return response;
  }
  throw new Error("generation_output_unavailable");
}

async function fetchDriveOutput(driveFileId: string): Promise<Response> {
  const auth = createDriveAuthClient();
  if (!auth) throw new Error("generation_output_drive_not_configured");
  const token = await getDriveAccessToken(auth);
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  return fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "*/*" },
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
}

async function resolveOutput(output: GenerationOutput): Promise<Response> {
  if (output.storageProvider === "google_drive" && output.driveFileId) {
    const response = await fetchDriveOutput(output.driveFileId);
    if (response.ok) return response;
  }
  const providerUrl = (output.providerUrl ?? output.url ?? "").trim();
  if (!providerUrl) throw new Error("generation_output_missing_source");
  return fetchProviderOutput(providerUrl);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ generationId: string; outputIndex: string }> },
) {
  const expectedToken = resolveSupabaseServiceRoleKey();
  if (!verifyIngestBearerToken(request.headers.get("authorization"), expectedToken ?? undefined)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { generationId, outputIndex } = await context.params;
  const index = Number(outputIndex);
  if (!generationId || !Number.isInteger(index) || index < 0 || index > 20) {
    return new Response("Not found", { status: 404 });
  }

  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("generations")
    .select("id,type,status,outputs")
    .eq("id", generationId)
    .maybeSingle();
  if (error || !data || data.status !== "completed") return new Response("Not found", { status: 404 });
  const outputs = Array.isArray(data.outputs) ? (data.outputs as GenerationOutput[]) : [];
  const output = outputs[index];
  if (!output) return new Response("Output not found", { status: 404 });

  try {
    const upstream = await resolveOutput(output);
    if (!upstream.ok || !upstream.body) return new Response("Output unavailable", { status: 502 });
    const headers = new Headers();
    headers.set(
      "Content-Type",
      upstream.headers.get("content-type") || output.mimeType || (data.type === "video" ? "video/mp4" : "image/png"),
    );
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) headers.set("Content-Length", contentLength);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(upstream.body, { status: 200, headers });
  } catch (error) {
    console.error("internal.generation_output.failed", {
      generation_id: generationId,
      output_index: index,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response("Output unavailable", { status: 502 });
  }
}
