import { describe, it, expect } from "vitest";
import {
  DriveStorageError,
  mapGoogleHttpStatusToDriveError,
  normalizeDriveError,
} from "@/lib/storage/drive-errors";

describe("mapGoogleHttpStatusToDriveError", () => {
  it("maps 401 to DRIVE_AUTH_FAILED", () => {
    expect(mapGoogleHttpStatusToDriveError(401, "upload_session")).toBe("DRIVE_AUTH_FAILED");
  });

  it("maps 403 to DRIVE_FOLDER_ACCESS_DENIED", () => {
    expect(mapGoogleHttpStatusToDriveError(403, "root_folder_access")).toBe(
      "DRIVE_FOLDER_ACCESS_DENIED",
    );
  });

  it("maps 404 to DRIVE_FOLDER_ACCESS_DENIED", () => {
    expect(mapGoogleHttpStatusToDriveError(404, "root_folder_access")).toBe(
      "DRIVE_FOLDER_ACCESS_DENIED",
    );
  });

  it("uses fallback code for other statuses", () => {
    expect(
      mapGoogleHttpStatusToDriveError(500, "upload_session", "DRIVE_UPLOAD_SESSION_FAILED"),
    ).toBe("DRIVE_UPLOAD_SESSION_FAILED");
  });
});

describe("normalizeDriveError", () => {
  it("returns existing DriveStorageError unchanged", () => {
    const original = new DriveStorageError("DRIVE_AUTH_FAILED", "Auth failed", {
      stage: "auth_token",
      googleHttpStatus: 401,
    });

    expect(normalizeDriveError(original, "auth_token")).toBe(original);
  });

  it("maps Gaxios-style 401 errors to DRIVE_AUTH_FAILED", () => {
    const err = normalizeDriveError(
      {
        code: 401,
        response: {
          status: 401,
          data: { error: { errors: [{ reason: "authError" }] } },
        },
      },
      "auth_token",
    );

    expect(err.code).toBe("DRIVE_AUTH_FAILED");
    expect(err.googleHttpStatus).toBe(401);
    expect(err.googleErrorReason).toBe("authError");
    expect(err.stage).toBe("auth_token");
  });

  it("maps Gaxios-style 403 errors to DRIVE_FOLDER_ACCESS_DENIED", () => {
    const err = normalizeDriveError(
      {
        code: 403,
        response: {
          status: 403,
          data: { error: { errors: [{ reason: "insufficientPermissions" }] } },
        },
      },
      "root_folder_access",
    );

    expect(err.code).toBe("DRIVE_FOLDER_ACCESS_DENIED");
    expect(err.googleHttpStatus).toBe(403);
    expect(err.googleErrorReason).toBe("insufficientPermissions");
  });

  it("maps Gaxios-style 404 errors to DRIVE_FOLDER_ACCESS_DENIED", () => {
    const err = normalizeDriveError(
      {
        code: 404,
        response: {
          status: 404,
          data: { error: { errors: [{ reason: "notFound" }] } },
        },
      },
      "root_folder_access",
    );

    expect(err.code).toBe("DRIVE_FOLDER_ACCESS_DENIED");
    expect(err.googleHttpStatus).toBe(404);
    expect(err.googleErrorReason).toBe("notFound");
  });
});
