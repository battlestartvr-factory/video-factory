import { NextResponse } from "next/server";
import { apiSuccess } from "@/lib/api/response";

export async function GET() {
  return apiSuccess({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? "0.1.0",
  });
}

export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}
