import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const FACTORY_ROUTE_FILES = [
  "app/api/factory/jobs/route.ts",
  "app/api/factory/jobs/[jobId]/actions/route.ts",
];

describe("factory API routes — auth and service patterns", () => {
  for (const file of FACTORY_ROUTE_FILES) {
    it(`${file} requires session before side effects`, () => {
      const source = readFileSync(join(process.cwd(), file), "utf-8");
      const fnBody = source.slice(source.indexOf("export async function POST"));
      expect(fnBody).toMatch(/requireFactoryUser/);
      const authIndex = fnBody.indexOf("requireFactoryUser");
      const rpcOrN8nIndex = Math.min(
        ...["createSupabaseServiceClient", "createFactoryJob", "sendFactoryJobAction"]
          .map((needle) => fnBody.indexOf(needle))
          .filter((idx) => idx >= 0),
      );
      expect(rpcOrN8nIndex).toBeGreaterThan(authIndex);
    });

    it(`${file} uses server-only n8n client with signature`, () => {
      const source = readFileSync(join(process.cwd(), file), "utf-8");
      expect(source).toMatch(/@\/lib\/factory\/n8n-server/);
    });
  }

  it("create route calls factory_create_or_get_job via service role", () => {
    const source = readFileSync(
      join(process.cwd(), "app/api/factory/jobs/route.ts"),
      "utf-8",
    );
    expect(source).toContain("createSupabaseServiceClient");
    expect(source).toContain("factory_create_or_get_job");
    expect(source).toContain("auth.user.id");
    expect(source).toMatch(/parsed\.data\.userId && parsed\.data\.userId !== auth\.user\.id/);
  });

  it("actions route validates foreign asset rejection path", () => {
    const source = readFileSync(
      join(process.cwd(), "app/api/factory/jobs/[jobId]/actions/route.ts"),
      "utf-8",
    );
    expect(source).toContain("validateFactoryAssetBelongsToJob");
    expect(source).toContain("INVALID_ASSET");
  });

  it("n8n-server module is server-only", () => {
    const source = readFileSync(
      join(process.cwd(), "lib/factory/n8n-server.ts"),
      "utf-8",
    );
    expect(source).toContain('import "server-only"');
    expect(source).toContain("x-factory-signature");
    expect(source).not.toContain("NEXT_PUBLIC_");
  });

  it("env server validates factory vars without NEXT_PUBLIC prefix", () => {
    const source = readFileSync(join(process.cwd(), "lib/env/env.server.ts"), "utf-8");
    expect(source).toContain("N8N_FACTORY_BASE_URL");
    expect(source).toContain("FACTORY_WEBHOOK_SECRET");
  });
});

describe("factory API — response codes", () => {
  it("create route returns 202 accepted", () => {
    const source = readFileSync(
      join(process.cwd(), "app/api/factory/jobs/route.ts"),
      "utf-8",
    );
    expect(source).toMatch(/apiSuccess\([\s\S]*202/);
  });

  it("routes map n8n timeout to 504", () => {
    for (const file of FACTORY_ROUTE_FILES) {
      const source = readFileSync(join(process.cwd(), file), "utf-8");
      expect(source).toContain("FACTORY_N8N_TIMEOUT");
      expect(source).toMatch(/504/);
    }
  });
});
