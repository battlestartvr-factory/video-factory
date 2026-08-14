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

  try {
    console.log("CLAUDE_SMOKE_START", {
      model: "claude-sonnet-5",
      hasKey: Boolean(process.env.KIE_API_KEY),
    });

    const response = await kieFetch(
      { baseUrl: config.baseUrl, apiKey: config.apiKey, model },
      KIE_REQUEST_BODY,
      AGENT_PROVIDER_TIMEOUT_MS,
    );

    console.log("CLAUDE_SMOKE_RESPONSE", {
      status: response.status,
    });

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
  } catch (error) {
    console.error("CLAUDE_SMOKE_TEST_FAILED", error);

    return NextResponse.json(
      {
        error: {
          type: "api_error",
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : null,
        },
      },
      { status: 500 },
    );
  }
}
