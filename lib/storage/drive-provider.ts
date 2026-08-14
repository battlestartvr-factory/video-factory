import "server-only";
import { google } from "googleapis";
import { serverEnv } from "@/lib/env/env.server";

export type DriveAuthMode = "service_account" | "oauth_user";

export interface DriveFileMetadata {
  driveFileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number | null;
  webViewUrl: string | null;
  checksumSha256?: string | null;
}

export interface ResumableUploadSession {
  uploadUrl: string;
  driveFileId?: string;
}

export interface DriveStorageProvider {
  authMode: DriveAuthMode;
  isConfigured(): boolean;
  ensureFolderPath(segments: string[]): Promise<string>;
  createResumableUpload(input: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    folderId: string;
  }): Promise<ResumableUploadSession>;
  finalizeUpload(driveFileId: string): Promise<DriveFileMetadata>;
  downloadFile(driveFileId: string): Promise<Buffer>;
  deleteFile(driveFileId: string): Promise<void>;
  getFileMetadata(driveFileId: string): Promise<DriveFileMetadata>;
}

function normalizePrivateKey(key: string): string {
  return key.replace(/\\n/g, "\n").replace(/^"|"$/g, "");
}

function getAuthMode(): DriveAuthMode {
  const mode = (process.env.GOOGLE_DRIVE_AUTH_MODE ?? "service_account").trim();
  return mode === "oauth_user" ? "oauth_user" : "service_account";
}

function createDriveClient(): ReturnType<typeof google.drive> | null {
  const authMode = getAuthMode();

  if (authMode === "oauth_user") {
    const clientId = (process.env.GOOGLE_DRIVE_CLIENT_ID ?? "").trim();
    const clientSecret = (process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? "").trim();
    const refreshToken = (process.env.GOOGLE_DRIVE_REFRESH_TOKEN ?? "").trim();
    if (!clientId || !clientSecret || !refreshToken) return null;

    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });
    return google.drive({ version: "v3", auth: oauth2 });
  }

  const email = (serverEnv.GOOGLE_DRIVE_CLIENT_EMAIL ?? "").trim();
  const privateKey = normalizePrivateKey(serverEnv.GOOGLE_DRIVE_PRIVATE_KEY ?? "");
  if (!email || !privateKey) return null;

  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

class GoogleDriveStorageProviderImpl implements DriveStorageProvider {
  readonly authMode = getAuthMode();
  private readonly folderCache = new Map<string, string>();

  isConfigured(): boolean {
    return Boolean(createDriveClient());
  }

  private getClient() {
    const client = createDriveClient();
    if (!client) throw new Error("GOOGLE_DRIVE_NOT_CONFIGURED");
    return client;
  }

  async ensureFolderPath(segments: string[]): Promise<string> {
    const rootId = (serverEnv.GOOGLE_DRIVE_SHARED_FOLDER_ID ?? "").trim();
    if (!rootId) throw new Error("GOOGLE_DRIVE_SHARED_FOLDER_ID_MISSING");

    const drive = this.getClient();
    let parentId = rootId;

    for (const segment of segments) {
      const cacheKey = `${parentId}/${segment}`;
      const cached = this.folderCache.get(cacheKey);
      if (cached) {
        parentId = cached;
        continue;
      }

      const query = [
        `'${parentId}' in parents`,
        "mimeType='application/vnd.google-apps.folder'",
        "trashed=false",
        `name='${segment.replace(/'/g, "\\'")}'`,
      ].join(" and ");

      const existing = await drive.files.list({
        q: query,
        fields: "files(id,name)",
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const found = existing.data.files?.[0]?.id;
      if (found) {
        this.folderCache.set(cacheKey, found);
        parentId = found;
        continue;
      }

      const created = await drive.files.create({
        requestBody: {
          name: segment,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parentId],
        },
        fields: "id",
        supportsAllDrives: true,
      });
      const newId = created.data.id;
      if (!newId) throw new Error("DRIVE_FOLDER_CREATE_FAILED");
      this.folderCache.set(cacheKey, newId);
      parentId = newId;
    }

    return parentId;
  }

  async createResumableUpload(input: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    folderId: string;
  }): Promise<ResumableUploadSession> {
    const drive = this.getClient();
    const auth = drive.context._options.auth;
    const authClient = auth as { getClient?: () => Promise<{ getAccessToken: () => Promise<{ token?: string } | string> }> };
    const client = authClient.getClient ? await authClient.getClient() : null;
    const tokenResponse = client ? await client.getAccessToken() : null;
    const token = typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token;
    if (!token) throw new Error("DRIVE_AUTH_TOKEN_FAILED");

    const initResponse = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Upload-Content-Type": input.mimeType,
          "X-Upload-Content-Length": String(input.sizeBytes),
        },
        body: JSON.stringify({
          name: input.filename,
          mimeType: input.mimeType,
          parents: [input.folderId],
        }),
      },
    );

    if (!initResponse.ok) throw new Error("DRIVE_UPLOAD_SESSION_FAILED");
    const uploadUrl = initResponse.headers.get("Location");
    if (!uploadUrl) throw new Error("DRIVE_UPLOAD_SESSION_FAILED");

    return { uploadUrl };
  }

  async finalizeUpload(driveFileId: string): Promise<DriveFileMetadata> {
    return this.getFileMetadata(driveFileId);
  }

  async downloadFile(driveFileId: string): Promise<Buffer> {
    const drive = this.getClient();
    const response = await drive.files.get(
      { fileId: driveFileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" },
    );
    return Buffer.from(response.data as ArrayBuffer);
  }

  async deleteFile(driveFileId: string): Promise<void> {
    const drive = this.getClient();
    await drive.files.delete({ fileId: driveFileId, supportsAllDrives: true });
  }

  async getFileMetadata(driveFileId: string): Promise<DriveFileMetadata> {
    const drive = this.getClient();
    const response = await drive.files.get({
      fileId: driveFileId,
      fields: "id,name,mimeType,size,webViewLink,md5Checksum",
      supportsAllDrives: true,
    });
    const file = response.data;
    return {
      driveFileId: file.id ?? driveFileId,
      filename: file.name ?? driveFileId,
      mimeType: file.mimeType ?? "application/octet-stream",
      sizeBytes: file.size ? Number(file.size) : null,
      webViewUrl: file.webViewLink ?? null,
      checksumSha256: file.md5Checksum ?? null,
    };
  }
}

let cachedProvider: DriveStorageProvider | null = null;

export function getDriveStorageProvider(): DriveStorageProvider {
  if (!cachedProvider) cachedProvider = new GoogleDriveStorageProviderImpl();
  return cachedProvider;
}

export function isDriveStorageConfigured(): boolean {
  if (!serverEnv.GOOGLE_DRIVE_INTEGRATION_ENABLED) return false;
  return getDriveStorageProvider().isConfigured();
}

export function resolveKnowledgeFolderSegments(projectId?: string | null): string[] {
  if (projectId) return ["Knowledge", "Projects", projectId];
  return ["Knowledge", "Global"];
}
