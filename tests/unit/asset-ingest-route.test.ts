import { afterEach, describe, expect, it, vi } from "vitest";
import { baseIngestBody } from "./asset-ingest-fixtures";

vi.mock("@/lib/asset-ingest/ingest", () => ({
  runAssetIngest: vi.fn(),
}));

import { POST } from "@/app/api/internal/asset-ingest/route";
import { runAssetIngest } from "@/lib/asset-ingest/ingest";
import { IngestError } from "@/lib/asset-ingest/types";

const mockedRun = vi.mocked(runAssetIngest);

describe("POST /api/internal/asset-ingest", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.INGEST_PROXY_TOKEN;
  });

  it("returns 401 for invalid bearer token", async () => {
    process.env.INGEST_PROXY_TOKEN = "correct-token";
    const res = await POST(
      new Request("http://localhost/api/internal/asset-ingest", {
        method: "POST",
        headers: {
          Authorization: "Bearer wrong-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(baseIngestBody()),
      }),
    );
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("returns 400 INVALID_REQUEST for bad uuid", async () => {
    process.env.INGEST_PROXY_TOKEN = "correct-token";
    const res = await POST(
      new Request("http://localhost/api/internal/asset-ingest", {
        method: "POST",
        headers: {
          Authorization: "Bearer correct-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(baseIngestBody({ project_id: "not-a-uuid" })),
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
  });

  it("returns success payload without leaking internals", async () => {
    process.env.INGEST_PROXY_TOKEN = "correct-token";
    mockedRun.mockResolvedValue({
      ok: true,
      bucket: "battlestart-factory-temp",
      object_key: "temp/p/j/s/t-0.png",
      kind: "image",
      mime_type: "image/png",
      size_bytes: 128,
      checksum_sha256: "a".repeat(64),
    });

    const res = await POST(
      new Request("http://localhost/api/internal/asset-ingest", {
        method: "POST",
        headers: {
          Authorization: "Bearer correct-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(baseIngestBody()),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      bucket: "battlestart-factory-temp",
      object_key: "temp/p/j/s/t-0.png",
      kind: "image",
      mime_type: "image/png",
      size_bytes: 128,
      checksum_sha256: "a".repeat(64),
    });
    expect(JSON.stringify(body)).not.toMatch(/secret|stack|Authorization|signed/i);
  });

  it("maps IngestError to safe JSON codes", async () => {
    process.env.INGEST_PROXY_TOKEN = "correct-token";
    mockedRun.mockRejectedValue(new IngestError("INVALID_MIME", 400));

    const res = await POST(
      new Request("http://localhost/api/internal/asset-ingest", {
        method: "POST",
        headers: {
          Authorization: "Bearer correct-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(baseIngestBody()),
      }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      code: "INVALID_MIME",
    });
  });

  it("route exports nodejs runtime and maxDuration", async () => {
    const mod = await import("@/app/api/internal/asset-ingest/route");
    expect(mod.runtime).toBe("nodejs");
    expect(mod.maxDuration).toBe(300);
    expect(mod.dynamic).toBe("force-dynamic");
  });
});
