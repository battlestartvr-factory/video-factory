import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DriveStorageError } from "@/lib/storage/drive-errors";
import { getDriveAccessToken } from "@/lib/storage/drive-auth";
import type { DriveAuthClient } from "@/lib/storage/drive-auth";

describe("getDriveAccessToken", () => {
  it("retrieves token from JWT/service-account auth via getAccessToken()", async () => {
    const getAccessToken = vi.fn().mockResolvedValue({ token: "jwt-access-token" });
    const auth = { getAccessToken } as unknown as DriveAuthClient;

    const token = await getDriveAccessToken(auth);

    expect(token).toBe("jwt-access-token");
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("retrieves token from OAuth auth via getAccessToken()", async () => {
    const getAccessToken = vi.fn().mockResolvedValue({ token: "oauth-access-token" });
    const auth = { getAccessToken } as unknown as DriveAuthClient;

    const token = await getDriveAccessToken(auth);

    expect(token).toBe("oauth-access-token");
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("accepts string token responses", async () => {
    const getAccessToken = vi.fn().mockResolvedValue("raw-token");
    const auth = { getAccessToken } as unknown as DriveAuthClient;

    await expect(getDriveAccessToken(auth)).resolves.toBe("raw-token");
  });

  it("throws DRIVE_AUTH_FAILED when token is missing", async () => {
    const getAccessToken = vi.fn().mockResolvedValue({ token: undefined });
    const auth = { getAccessToken } as unknown as DriveAuthClient;

    await expect(getDriveAccessToken(auth)).rejects.toMatchObject({
      code: "DRIVE_AUTH_FAILED",
      stage: "auth_token",
    });
  });
});

describe("drive-provider auth implementation", () => {
  it("does not use drive.context._options.auth for token retrieval", () => {
    const source = readFileSync(path.join(process.cwd(), "lib/storage/drive-provider.ts"), "utf8");
    expect(source).not.toContain("context._options.auth");
    expect(source).not.toContain("_options.auth");
  });
});

describe("DriveStorageError", () => {
  it("preserves normalized metadata", () => {
    const err = new DriveStorageError("DRIVE_FOLDER_ACCESS_DENIED", "Denied", {
      stage: "root_folder_access",
      googleHttpStatus: 403,
      googleErrorReason: "insufficientPermissions",
    });

    expect(err.code).toBe("DRIVE_FOLDER_ACCESS_DENIED");
    expect(err.stage).toBe("root_folder_access");
    expect(err.googleHttpStatus).toBe(403);
    expect(err.googleErrorReason).toBe("insufficientPermissions");
  });
});
