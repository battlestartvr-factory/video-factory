import { NextResponse } from "next/server";
import type { ApiResponse } from "@/lib/types/database";
import { generateRequestId } from "@/lib/logging/logger";

export function apiSuccess<T>(data: T, status = 200) {
  const body: ApiResponse<T> = { ok: true, data };
  return NextResponse.json(body, { status });
}

export function apiError(
  code: string,
  message: string,
  status = 400,
  requestId = generateRequestId(),
) {
  const body: ApiResponse<never> = {
    ok: false,
    error: { code, message, requestId },
  };
  return NextResponse.json(body, { status });
}

export async function readJsonBody<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}
