import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const compose = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf-8");
const deploy = readFileSync(join(process.cwd(), "scripts/deploy.sh"), "utf-8");

describe("production shared assembly workspace", () => {
  it("initializes Stage 4 assembly directories for the non-root app and worker uid", () => {
    expect(compose).toMatch(/data-init:/);
    expect(compose).toMatch(/user: "0:0"/);
    expect(compose).toMatch(/discovery-assembly-staging/);
    expect(compose).toMatch(/discovery-assembly-output/);
    expect(compose).toMatch(/chown 1001:1001/);
    expect(compose).toMatch(/condition: service_completed_successfully/);
  });

  it("fails deployment if the worker cannot write the assembly workspace", () => {
    expect(deploy).toMatch(/Verifying shared assembly workspace permissions/);
    expect(deploy).toMatch(/test -w "\$dir"/);
    expect(deploy).toMatch(/worker cannot write to the shared discovery assembly workspace/);
    expect(deploy).toMatch(/App cannot read the shared discovery assembly staging workspace/);
  });
});
