import { NextResponse } from "next/server";
import { AGENT_PROVIDER_TIMEOUT_MS } from "@/lib/agent/config";
import { getKieConfig } from "@/lib/env/env.server";
import { kieFetch } from "@/lib/models/kie/adapters/base";
import { getKieModelById } from "@/lib/models/kie/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLAUDE_TEST_MODEL = "claude-sonnet-5";

const KIE_REQUEST_BODY = {
  model: CLAUDE_TEST_MODEL,
  messages: [
    {
      role: "user",
      content: "Say hello",
    },
  ],
  max_tokens: 100,
} as const;

export async function POST() {
  const config = getKieConfig();
  if (!config.configured) {
    return NextResponse.json(
      { error: "KIE provider is not configured" },
      { status: 503 },
    );
  }

  const model = getKieModelById(CLAUDE_TEST_MODEL);
  if (!model) {
    return NextResponse.json(
      { error: `Model not found: ${CLAUDE_TEST_MODEL}` },
      { status: 500 },
    );
  }

  const response = await kieFetch(
    { baseUrl: config.baseUrl, apiKey: config.apiKey, model },
    KIE_REQUEST_BODY,
    AGENT_PROVIDER_TIMEOUT_MS,
  );

  const rawBody = await response.text();
  let responseBody: unknown = rawBody;
  try {
    responseBody = JSON.parse(rawBody) as unknown;
  } catch {
    // keep raw text when KIE returns non-JSON
  }

  return NextResponse.json(
    {
      httpStatus: response.status,
      responseBody,
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
