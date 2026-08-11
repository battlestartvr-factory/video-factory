import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const WRITE_ROUTE_FILES = [
  "app/api/jobs/route.ts",
  "app/api/jobs/[id]/cancel/route.ts",
  "app/api/jobs/[id]/retry/route.ts",
  "app/api/jobs/[id]/review/route.ts",
  "lib/api/projects-handler.ts",
];

describe("API routes use service client for writes", () => {
  for (const file of WRITE_ROUTE_FILES) {
    it(`${file} calls createSupabaseServiceClient for mutations`, () => {
      const source = readFileSync(join(process.cwd(), file), "utf-8");
      expect(source).toContain("createSupabaseServiceClient");
      expect(source).toMatch(/service\.from\(|createSupabaseServiceClient\(\)/);
    });

    it(`${file} keeps auth checks before service writes`, () => {
      const source = readFileSync(join(process.cwd(), file), "utf-8");
      const fnBody = source.slice(source.indexOf("export async function POST"));
      expect(fnBody).toMatch(/getSessionUser/);
      const authIndex = fnBody.indexOf("getSessionUser");
      const serviceIndex = fnBody.indexOf("createSupabaseServiceClient");
      expect(authIndex).toBeGreaterThan(-1);
      expect(serviceIndex).toBeGreaterThan(authIndex);
    });
  }

  it("write routes do not mutate via createSupabaseServerClient", () => {
    for (const file of WRITE_ROUTE_FILES) {
      const source = readFileSync(join(process.cwd(), file), "utf-8");
      const serverBlocks = source.split("createSupabaseServerClient");
      for (const block of serverBlocks.slice(1)) {
        const nextService = block.indexOf("createSupabaseServiceClient");
        const slice =
          nextService === -1 ? block : block.slice(0, nextService);
        expect(slice).not.toMatch(/\.(insert|update|upsert|delete)\(/);
      }
    }
  });
});

describe("API routes auth pattern", () => {
  it("job cancel route reads with server client and writes with service client", () => {
    const source = readFileSync(
      join(process.cwd(), "app/api/jobs/[id]/cancel/route.ts"),
      "utf-8",
    );
    expect(source).toContain("createSupabaseServerClient");
    expect(source).toContain("createSupabaseServiceClient");
    expect(source).toMatch(/getJobWithAccess|getSessionUser/);
  });
});
