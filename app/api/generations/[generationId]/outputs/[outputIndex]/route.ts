import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { validateWebFetchUrl } from "@/lib/web/url-safety";
import type { Generation } from "@/lib/types/workspace";

const MAX_REDIRECTS = 4;
const UPSTREAM_TIMEOUT_MS = 60_000;

function outputExtension(contentType: string | null, rawUrl: string): string {
  const normalized = (contentType ?? "").split(";", 1)[0]?.trim().toLowerCase();
  const byType: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  };
  if (normalized && byType[normalized]) return byType[normalized]!;

  try {
    const pathname = new URL(rawUrl).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
    if (match?.[1]) return match[1].toLowerCase();
  } catch {
    // The URL was already validated before this helper is used.
  }
  return "bin";
}

async function fetchProviderOutput(rawUrl: string, range: string | null): Promise<Response> {
  let current = await validateWebFetchUrl(rawUrl);
  if (current.protocol !== "https:") throw new Error("generation_output_requires_https");

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "*/*",
        "User-Agent": "AI-Content-Factory/1.0",
        ...(range ? { Range: range } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new Error("generation_output_redirect_failed");
      }
      const redirected = new URL(location, current);
      current = await validateWebFetchUrl(redirected.toString());
      if (current.protocol !== "https:") throw new Error("generation_output_requires_https");
      continue;
    }

    return response;
  }

  throw new Error("generation_output_unavailable");
}

export async function GET(
  request: Request,
  context: { params: Promise<{ generationId: string; outputIndex: string }> },
) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { generationId, outputIndex } = await context.params;
  const index = Number(outputIndex);
  if (!generationId || !Number.isInteger(index) || index < 0 || index > 20) {
    return new Response("Not found", { status: 404 });
  }

  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("generations")
    .select("id,user_id,type,outputs")
    .eq("id", generationId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error || !data) return new Response("Not found", { status: 404 });

  const generation = data as Pick<Generation, "id" | "user_id" | "type" | "outputs">;
  const output = Array.isArray(generation.outputs) ? generation.outputs[index] : undefined;
  const rawUrl = output && typeof output.url === "string" ? output.url.trim() : "";
  if (!rawUrl) return new Response("Output not found", { status: 404 });

  try {
    const upstream = await fetchProviderOutput(rawUrl, request.headers.get("range"));
    if (!upstream.ok && upstream.status !== 206) {
      console.warn("generation.output.upstream_rejected", {
        generation_id: generationId,
        output_index: index,
        status: upstream.status,
      });
      return new Response("Output unavailable", { status: 502 });
    }

    const headers = new Headers();
    for (const name of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "etag",
      "last-modified",
    ]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }

    if (!headers.has("content-type")) {
      headers.set("Content-Type", generation.type === "video" ? "video/mp4" : "image/png");
    }
    headers.set("Cache-Control", "private, max-age=3600");
    headers.set("X-Content-Type-Options", "nosniff");

    const download = new URL(request.url).searchParams.get("download") === "1";
    if (download) {
      const extension = outputExtension(headers.get("content-type"), rawUrl);
      headers.set(
        "Content-Disposition",
        `attachment; filename="generation-${generationId}-${index + 1}.${extension}"`,
      );
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    console.error("generation.output.proxy_failed", {
      generation_id: generationId,
      output_index: index,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response("Output unavailable", { status: 502 });
  }
}
