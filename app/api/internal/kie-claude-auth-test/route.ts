import { NextResponse } from "next/server";
import { verifyIngestBearerToken } from "@/lib/asset-ingest/auth";
import { getKieConfig } from "@/lib/env/env.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ВРЕМЕННЫЙ диагностический endpoint — удалить после закрытия расследования 403 Claude/KIE.
 *
 * Шлёт один и тот же минимальный body в KIE Claude proxy трижды с разными
 * вариантами auth-заголовков через чистый fetch (без SDK, без retry, без
 * streaming, без tools, без agent-контекста).
 *
 * Защищён тем же INGEST_PROXY_TOKEN Bearer-чеком, что и app/api/internal/asset-ingest.
 *
 * Использование:
 *   POST /api/internal/kie-claude-auth-test
 *   Authorization: Bearer <INGEST_PROXY_TOKEN>
 */

type VariantName = "A_bearer_only" | "B_anthropic_style" | "C_both";

type VariantResult = {
  variant: VariantName;
  headers_sent: string[];
  http_status: number | null;
  response_body: string;
  error?: string;
};

const REQUEST_BODY = {
  model: "claude-sonnet-5",
  messages: [
    {
      role: "user",
      content: "Say hello",
    },
  ],
  max_tokens: 100,
  stream: false,
};

async function runVariant(
  variant: VariantName,
  url: string,
  headers: Record<string, string>,
): Promise<VariantResult> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(REQUEST_BODY),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text().catch(() => "");
    return {
      variant,
      headers_sent: Object.keys(headers),
      http_status: response.status,
      response_body: text.slice(0, 4000),
    };
  } catch (err) {
    return {
      variant,
      headers_sent: Object.keys(headers),
      http_status: null,
      response_body: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function POST(request: Request) {
  const expectedToken = process.env.INGEST_PROXY_TOKEN;
  const authorization = request.headers.get("authorization");

  if (!verifyIngestBearerToken(authorization, expectedToken)) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }

  const { baseUrl, apiKey, configured } = getKieConfig();
  if (!configured) {
    return NextResponse.json({ ok: false, error: "KIE_NOT_CONFIGURED" }, { status: 500 });
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/claude/v1/messages`;

  const variantA = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const variantB = {
    "X-Api-Key": apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };
  const variantC = {
    Authorization: `Bearer ${apiKey}`,
    "X-Api-Key": apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };

  const results = await Promise.all([
    runVariant("A_bearer_only", url, variantA),
    runVariant("B_anthropic_style", url, variantB),
    runVariant("C_both", url, variantC),
  ]);

  return NextResponse.json({ ok: true, url, results }, { status: 200 });
}
