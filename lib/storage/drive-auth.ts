import "server-only";
import { google } from "googleapis";
import { serverEnv } from "@/lib/env/env.server";
import type { DriveAuthMode } from "@/lib/storage/drive-errors";
import { DriveStorageError } from "@/lib/storage/drive-errors";

export type DriveAuthClient =
  | InstanceType<typeof google.auth.OAuth2>
  | InstanceType<typeof google.auth.JWT>;

function normalizePrivateKey(key: string): string {
  return key.replace(/\\n/g, "\n").replace(/^"|"$/g, "");
}

export function getDriveAuthMode(): DriveAuthMode {
  const mode = (process.env.GOOGLE_DRIVE_AUTH_MODE ?? "service_account").trim();
  return mode === "oauth_user" ? "oauth_user" : "service_account";
}

export function createDriveAuthClient(): DriveAuthClient | null {
  const authMode = getDriveAuthMode();

  if (authMode === "oauth_user") {
    const clientId = (process.env.GOOGLE_DRIVE_CLIENT_ID ?? "").trim();
    const clientSecret = (process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? "").trim();
    const refreshToken = (process.env.GOOGLE_DRIVE_REFRESH_TOKEN ?? "").trim();
    if (!clientId || !clientSecret || !refreshToken) return null;

    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });
    return oauth2;
  }

  const email = (serverEnv.GOOGLE_DRIVE_CLIENT_EMAIL ?? "").trim();
  const privateKey = normalizePrivateKey(serverEnv.GOOGLE_DRIVE_PRIVATE_KEY ?? "");
  if (!email || !privateKey) return null;

  return new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}

export async function getDriveAccessToken(auth: DriveAuthClient): Promise<string> {
  const tokenResponse = await auth.getAccessToken();
  const token = typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token;
  if (!token) {
    throw new DriveStorageError("DRIVE_AUTH_FAILED", "Failed to obtain Google Drive access token", {
      stage: "auth_token",
    });
  }
  return token;
}

export function createDriveApiClient(auth: DriveAuthClient): ReturnType<typeof google.drive> {
  return google.drive({ version: "v3", auth });
}
