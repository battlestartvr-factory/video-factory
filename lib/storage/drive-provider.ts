import "server-only";
import {
  createDriveApiClient,
  createDriveAuthClient,
  getDriveAccessToken,
  getDriveAuthMode,
} from "@/lib/storage/drive-auth";
import {
  DriveStorageError,
  normalizeDriveError,
  type DriveAuthMode,
} from "@/lib/storage/drive-errors";

export type {
  DriveAuthMode,
  DriveErrorCode,
  DriveErrorDetails,
} from "@/lib/storage/drive-errors";
export {
  DriveStorageError,
  driveErrorHttpStatus,
  driveErrorUserMessage,
  mapGoogleHttpStatusToDriveError,
  normalizeDriveError,
} from "@/lib/storage/drive-errors";
export {
  createDriveAuthClient,
  createDriveApiClient,
  getDriveAccessToken,
  getDriveAuthMode,
  type DriveAuthClient,
} from "@/lib/storage/drive-auth";

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
  completeResumableUpload(input: {
    uploadUrl: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<string>;
  finalizeUpload(driveFileId: string): Promise<DriveFileMetadata>;
  downloadFile(driveFileId: string): Promise<Buffer>;
  deleteFile(driveFileId: string): Promise<void>;
  getFileMetadata(driveFileId: string): Promise<DriveFileMetadata>;
}

interface RootFolderContext {
  rootId: string;
}

const SHARED_DRIVE_LIST_OPTIONS = {
  supportsAllDrives: true as const,
  includeItemsFromAllDrives: true as const,
};

const SHARED_DRIVE_MUTATION_OPTIONS = {
  supportsAllDrives: true as const,
};

class GoogleDriveStorageProviderImpl implements DriveStorageProvider {
  readonly authMode = getDriveAuthMode();
  private readonly folderCache = new Map<string, string>();
  private rootFolderContext: RootFolderContext | null = null;

  isConfigured(): boolean {
    return Boolean(createDriveAuthClient());
  }

  private getAuthAndDrive() {
    const auth = createDriveAuthClient();
    if (!auth) {
      throw new DriveStorageError(
        "DRIVE_NOT_CONFIGURED",
        "Google Drive credentials are not configured",
        { stage: "auth_config" },
      );
    }
    return { auth, drive: createDriveApiClient(auth) };
  }

  private async ensureRootFolderReady(): Promise<RootFolderContext> {
    if (this.rootFolderContext) return this.rootFolderContext;

    const rootId = (process.env.GOOGLE_DRIVE_SHARED_FOLDER_ID ?? "").trim();
    if (!rootId) {
      throw new DriveStorageError(
        "DRIVE_NOT_CONFIGURED",
        "GOOGLE_DRIVE_SHARED_FOLDER_ID is not configured",
        { stage: "root_folder_config" },
      );
    }

    const { drive } = this.getAuthAndDrive();

    try {
      const fileResponse = await drive.files.get({
        fileId: rootId,
        fields: "id,name,mimeType",
        ...SHARED_DRIVE_MUTATION_OPTIONS,
      });

      const file = fileResponse.data;
      if (!file.id) {
        throw new DriveStorageError(
          "DRIVE_FOLDER_NOT_FOUND",
          "Root Google Drive folder was not found",
          { stage: "root_folder_access", googleHttpStatus: 404 },
        );
      }

      if (file.mimeType && file.mimeType !== "application/vnd.google-apps.folder") {
        throw new DriveStorageError(
          "DRIVE_FOLDER_ACCESS_DENIED",
          "GOOGLE_DRIVE_SHARED_FOLDER_ID must reference a folder",
          { stage: "root_folder_access" },
        );
      }

      await drive.files.list({
        q: `'${rootId}' in parents and trashed=false`,
        fields: "files(id)",
        pageSize: 1,
        ...SHARED_DRIVE_LIST_OPTIONS,
      });

      this.rootFolderContext = { rootId };
      return this.rootFolderContext;
    } catch (err) {
      if (err instanceof DriveStorageError) throw err;
      throw normalizeDriveError(err, "root_folder_access", "DRIVE_FOLDER_ACCESS_DENIED");
    }
  }

  async ensureFolderPath(segments: string[]): Promise<string> {
    const { rootId } = await this.ensureRootFolderReady();
    const { drive } = this.getAuthAndDrive();
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

      try {
        const existing = await drive.files.list({
          q: query,
          fields: "files(id,name)",
          pageSize: 1,
          ...SHARED_DRIVE_LIST_OPTIONS,
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
          ...SHARED_DRIVE_MUTATION_OPTIONS,
        });
        const newId = created.data.id;
        if (!newId) {
          throw new DriveStorageError(
            "DRIVE_FOLDER_CREATE_FAILED",
            "Google Drive did not return a folder id",
            { stage: "folder_create" },
          );
        }
        this.folderCache.set(cacheKey, newId);
        parentId = newId;
      } catch (err) {
        if (err instanceof DriveStorageError) throw err;
        throw normalizeDriveError(err, "folder_create", "DRIVE_FOLDER_CREATE_FAILED");
      }
    }

    return parentId;
  }

  async createResumableUpload(input: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    folderId: string;
  }): Promise<ResumableUploadSession> {
    await this.ensureRootFolderReady();
    const { auth } = this.getAuthAndDrive();

    let token: string;
    try {
      token = await getDriveAccessToken(auth);
    } catch (err) {
      throw normalizeDriveError(err, "auth_token", "DRIVE_AUTH_FAILED");
    }

    const uploadParams = new URLSearchParams({
      uploadType: "resumable",
      supportsAllDrives: "true",
    });

    const initResponse = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files?${uploadParams.toString()}`,
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

    if (!initResponse.ok) {
      let googleErrorReason: string | undefined;
      try {
        const body = (await initResponse.json()) as {
          error?: { errors?: Array<{ reason?: string }> };
        };
        googleErrorReason = body.error?.errors?.[0]?.reason;
      } catch {
        // Ignore malformed error bodies.
      }

      const code =
        initResponse.status === 401
          ? "DRIVE_AUTH_FAILED"
          : initResponse.status === 403
            ? "DRIVE_FOLDER_ACCESS_DENIED"
            : initResponse.status === 404
              ? "DRIVE_FOLDER_NOT_FOUND"
              : "DRIVE_UPLOAD_SESSION_FAILED";

      const message =
        initResponse.status === 403
          ? "Permission denied: cannot create upload session in Google Drive folder"
          : initResponse.status === 404
            ? "Folder not found: Google Drive folder for upload does not exist"
            : "Failed to create Google Drive upload session";

      throw new DriveStorageError(code, message, {
        stage: "upload_session",
        googleHttpStatus: initResponse.status,
        ...(googleErrorReason ? { googleErrorReason } : {}),
      });
    }

    const uploadUrl = initResponse.headers.get("Location");
    if (!uploadUrl) {
      throw new DriveStorageError(
        "DRIVE_UPLOAD_SESSION_FAILED",
        "Google Drive upload session did not return a Location header",
        { stage: "upload_session" },
      );
    }

    return { uploadUrl };
  }

  async completeResumableUpload(input: {
    uploadUrl: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<string> {
    const response = await fetch(input.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": input.mimeType,
        "Content-Length": String(input.buffer.length),
      },
      body: new Uint8Array(input.buffer),
    });

    if (!response.ok) {
      throw new DriveStorageError(
        "DRIVE_UPLOAD_FAILED",
        "Failed to upload file to Google Drive",
        {
          stage: "upload_complete",
          googleHttpStatus: response.status,
        },
      );
    }

    try {
      const body = (await response.json()) as { id?: string };
      if (body.id) return body.id;
    } catch {
      // Response may be empty when the session was already completed.
    }

    throw new DriveStorageError(
      "DRIVE_UPLOAD_FAILED",
      "Google Drive upload completed but file id was not returned",
      { stage: "upload_complete" },
    );
  }

  async finalizeUpload(driveFileId: string): Promise<DriveFileMetadata> {
    return this.getFileMetadata(driveFileId);
  }

  async downloadFile(driveFileId: string): Promise<Buffer> {
    await this.ensureRootFolderReady();
    const { drive } = this.getAuthAndDrive();
    const response = await drive.files.get(
      {
        fileId: driveFileId,
        alt: "media",
        ...SHARED_DRIVE_MUTATION_OPTIONS,
      },
      { responseType: "arraybuffer" },
    );
    return Buffer.from(response.data as ArrayBuffer);
  }

  async deleteFile(driveFileId: string): Promise<void> {
    await this.ensureRootFolderReady();
    const { drive } = this.getAuthAndDrive();
    await drive.files.delete({
      fileId: driveFileId,
      ...SHARED_DRIVE_MUTATION_OPTIONS,
    });
  }

  async getFileMetadata(driveFileId: string): Promise<DriveFileMetadata> {
    await this.ensureRootFolderReady();
    const { drive } = this.getAuthAndDrive();
    const response = await drive.files.get({
      fileId: driveFileId,
      fields: "id,name,mimeType,size,webViewLink,md5Checksum",
      ...SHARED_DRIVE_MUTATION_OPTIONS,
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
  const enabled = (process.env.GOOGLE_DRIVE_INTEGRATION_ENABLED ?? "").trim() === "true";
  if (!enabled) return false;
  return getDriveStorageProvider().isConfigured();
}

export function resolveKnowledgeFolderSegments(projectId?: string | null): string[] {
  if (projectId) return ["Knowledge", "Projects", projectId];
  return ["Knowledge", "Global"];
}
