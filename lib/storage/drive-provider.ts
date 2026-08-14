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
  finalizeUpload(driveFileId: string): Promise<DriveFileMetadata>;
  downloadFile(driveFileId: string): Promise<Buffer>;
  deleteFile(driveFileId: string): Promise<void>;
  getFileMetadata(driveFileId: string): Promise<DriveFileMetadata>;
}

interface RootFolderContext {
  rootId: string;
  supportsAllDrives: boolean;
}

function sharedDriveListOptions(supportsAllDrives: boolean) {
  return supportsAllDrives
    ? { supportsAllDrives: true as const, includeItemsFromAllDrives: true as const }
    : {};
}

function sharedDriveMutationOptions(supportsAllDrives: boolean) {
  return supportsAllDrives ? { supportsAllDrives: true as const } : {};
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { code?: number; response?: { status?: number } };
  return candidate.code === 404 || candidate.response?.status === 404;
}

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
    let supportsAllDrives = false;

    try {
      let fileResponse;
      try {
        fileResponse = await drive.files.get({
          fileId: rootId,
          fields: "id,name,mimeType,driveId,capabilities",
        });
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
        fileResponse = await drive.files.get({
          fileId: rootId,
          fields: "id,name,mimeType,driveId,capabilities",
          supportsAllDrives: true,
        });
        supportsAllDrives = true;
      }

      const file = fileResponse.data;
      if (!file.id) {
        throw new DriveStorageError(
          "DRIVE_FOLDER_ACCESS_DENIED",
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

      if (!supportsAllDrives) {
        supportsAllDrives = Boolean(file.driveId);
      }

      if (file.capabilities?.canAddChildren === false) {
        throw new DriveStorageError(
          "DRIVE_FOLDER_ACCESS_DENIED",
          "Google Drive identity cannot create folders in the root folder",
          { stage: "root_folder_access", googleHttpStatus: 403 },
        );
      }

      await drive.files.list({
        q: `'${rootId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: "files(id)",
        pageSize: 1,
        ...sharedDriveListOptions(supportsAllDrives),
      });

      this.rootFolderContext = { rootId, supportsAllDrives };
      return this.rootFolderContext;
    } catch (err) {
      throw normalizeDriveError(err, "root_folder_access", "DRIVE_FOLDER_ACCESS_DENIED");
    }
  }

  async ensureFolderPath(segments: string[]): Promise<string> {
    const { rootId, supportsAllDrives } = await this.ensureRootFolderReady();
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
          ...sharedDriveListOptions(supportsAllDrives),
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
          ...sharedDriveMutationOptions(supportsAllDrives),
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
    const { supportsAllDrives } = await this.ensureRootFolderReady();
    const { auth } = this.getAuthAndDrive();

    let token: string;
    try {
      token = await getDriveAccessToken(auth);
    } catch (err) {
      throw normalizeDriveError(err, "auth_token", "DRIVE_AUTH_FAILED");
    }

    const uploadParams = new URLSearchParams({ uploadType: "resumable" });
    if (supportsAllDrives) uploadParams.set("supportsAllDrives", "true");

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
          : initResponse.status === 403 || initResponse.status === 404
            ? "DRIVE_FOLDER_ACCESS_DENIED"
            : "DRIVE_UPLOAD_SESSION_FAILED";

      throw new DriveStorageError(code, "Failed to create Google Drive upload session", {
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

  async finalizeUpload(driveFileId: string): Promise<DriveFileMetadata> {
    return this.getFileMetadata(driveFileId);
  }

  async downloadFile(driveFileId: string): Promise<Buffer> {
    const { supportsAllDrives } = await this.ensureRootFolderReady();
    const { drive } = this.getAuthAndDrive();
    const response = await drive.files.get(
      {
        fileId: driveFileId,
        alt: "media",
        ...sharedDriveMutationOptions(supportsAllDrives),
      },
      { responseType: "arraybuffer" },
    );
    return Buffer.from(response.data as ArrayBuffer);
  }

  async deleteFile(driveFileId: string): Promise<void> {
    const { supportsAllDrives } = await this.ensureRootFolderReady();
    const { drive } = this.getAuthAndDrive();
    await drive.files.delete({
      fileId: driveFileId,
      ...sharedDriveMutationOptions(supportsAllDrives),
    });
  }

  async getFileMetadata(driveFileId: string): Promise<DriveFileMetadata> {
    const { supportsAllDrives } = await this.ensureRootFolderReady();
    const { drive } = this.getAuthAndDrive();
    const response = await drive.files.get({
      fileId: driveFileId,
      fields: "id,name,mimeType,size,webViewLink,md5Checksum",
      ...sharedDriveMutationOptions(supportsAllDrives),
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
