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
    console.log("CLAUDE_KIE_REQUEST", {
      model: KIE_REQUEST_BODY.model,
      messages: KIE_REQUEST_BODY.messages,
      max_tokens: KIE_REQUEST_BODY.max_tokens,
    });

    const response = await kieFetch(
      { baseUrl: config.baseUrl, apiKey: config.apiKey, model },
      KIE_REQUEST_BODY,
      AGENT_PROVIDER_TIMEOUT_MS,
    );

    const text = await response.text();

    console.log("CLAUDE_KIE_RAW_RESPONSE", {
      status: response.status,
      body: text.slice(0, 4000),
    });

    return NextResponse.json(
      {
        httpStatus: response.status,
        rawBody: text,
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
