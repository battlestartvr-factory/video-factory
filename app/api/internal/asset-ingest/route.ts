import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { verifyIngestBearerToken } from "@/lib/asset-ingest/auth";
import { runAssetIngest } from "@/lib/asset-ingest/ingest";
import { parseAssetIngestRequest } from "@/lib/asset-ingest/request";
import {
  IngestError,
  type AssetIngestFailure,
  type AssetIngestResponse,
} from "@/lib/asset-ingest/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function errorResponse(code: AssetIngestFailure["code"], status: number) {
  const body: AssetIngestFailure = { ok: false, code };
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function successResponse(body: Exclude<AssetIngestResponse, AssetIngestFailure>) {
  return NextResponse.json(body, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export async function POST(request: Request) {
  const expectedToken = process.env.INGEST_PROXY_TOKEN;
  const authorization = request.headers.get("authorization");

  if (!verifyIngestBearerToken(authorization, expectedToken)) {
    return errorResponse("UNAUTHORIZED", 401);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse("INVALID_REQUEST", 400);
  }

  let payload;
  try {
    payload = parseAssetIngestRequest(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse("INVALID_REQUEST", 400);
    }
    return errorResponse("INVALID_REQUEST", 400);
  }

  try {
    const result = await runAssetIngest(payload);
    return successResponse(result);
  } catch (err) {
    if (err instanceof IngestError) {
      return errorResponse(err.code, err.status);
    }
    return errorResponse("UPSTREAM_ERROR", 502);
  }
}
