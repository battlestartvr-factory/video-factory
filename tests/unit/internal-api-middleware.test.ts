import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../../middleware";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("internal API middleware guard", () => {
  it("rejects internal requests when the bearer token is missing", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

    const response = await middleware(
      new NextRequest("https://factory.example/api/internal/research-scout-execute", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects an invalid bearer token", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

    const response = await middleware(
      new NextRequest("https://factory.example/api/internal/generation-archive/backfill", {
        method: "POST",
        headers: { authorization: "Bearer wrong-key" },
      }),
    );

    expect(response.status).toBe(401);
  });

  it("allows an internal request with the service-role bearer token", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

    const response = await middleware(
      new NextRequest("https://factory.example/api/internal/gameplay-reference-sync", {
        method: "POST",
        headers: { authorization: "Bearer test-service-role-key" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("uses SUPABASE_SECRET_KEY as the server-key fallback", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "test-secret-key");

    const response = await middleware(
      new NextRequest("https://factory.example/api/internal/test", {
        headers: { authorization: "Bearer test-secret-key" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("fails closed if no server-side key is configured", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");

    const response = await middleware(
      new NextRequest("https://factory.example/api/internal/test", {
        headers: { authorization: "Bearer anything" },
      }),
    );

    expect(response.status).toBe(401);
  });
});
