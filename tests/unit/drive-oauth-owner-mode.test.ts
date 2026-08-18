import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("Google Drive owner OAuth production contract", () => {
  it("prefers complete owner OAuth credentials over the legacy service-account path", () => {
    const auth = source("lib/storage/drive-auth.ts");
    expect(auth).toContain("hasCompleteOAuthCredentials");
    expect(auth).toContain('if (hasCompleteOAuthCredentials()) return "oauth_user"');
    expect(auth).toContain("GOOGLE_DRIVE_REFRESH_TOKEN");
  });

  it("forces oauth_user inside both production containers", () => {
    const compose = source("docker-compose.yml");
    const matches = compose.match(/GOOGLE_DRIVE_AUTH_MODE: oauth_user/g) ?? [];
    expect(matches).toHaveLength(2);
  });

  it("makes production preflight and deploy require owner OAuth secrets", () => {
    const workflow = source(".github/workflows/deploy-production.yml");
    const deploy = source("scripts/deploy.sh");

    for (const name of [
      "GOOGLE_DRIVE_CLIENT_ID",
      "GOOGLE_DRIVE_CLIENT_SECRET",
      "GOOGLE_DRIVE_REFRESH_TOKEN",
    ]) {
      expect(workflow).toContain(`${name} missing`);
      expect(deploy).toContain(`${name}:?${name} is required for owner Drive OAuth`);
    }

    expect(workflow).toContain("runtime auth mode will be oauth_user");
    expect(deploy).toContain("export GOOGLE_DRIVE_AUTH_MODE=oauth_user");
  });
});
