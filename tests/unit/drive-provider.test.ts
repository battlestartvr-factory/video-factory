import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFilesGet = vi.fn();
const mockFilesList = vi.fn();
const mockFilesCreate = vi.fn();
const mockGetAccessToken = vi.fn();

const mockDrive = {
  files: {
    get: mockFilesGet,
    list: mockFilesList,
    create: mockFilesCreate,
  },
};

vi.mock("@/lib/storage/drive-auth", () => ({
  createDriveAuthClient: vi.fn(() => ({})),
  createDriveApiClient: vi.fn(() => mockDrive),
  getDriveAccessToken: (...args: unknown[]) => mockGetAccessToken(...args),
  getDriveAuthMode: vi.fn(() => "oauth_user"),
}));

describe("GoogleDriveStorageProvider shared folder support", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("GOOGLE_DRIVE_SHARED_FOLDER_ID", "shared-root-folder-id");
    mockFilesGet.mockReset();
    mockFilesList.mockReset();
    mockFilesCreate.mockReset();
    mockGetAccessToken.mockReset();
    mockGetAccessToken.mockResolvedValue("test-access-token");

    mockFilesGet.mockResolvedValue({
      data: {
        id: "shared-root-folder-id",
        name: "Shared Root",
        mimeType: "application/vnd.google-apps.folder",
      },
    });
    mockFilesList.mockResolvedValue({ data: { files: [] } });
    mockFilesCreate.mockResolvedValue({ data: { id: "new-folder-id" } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function loadProvider() {
    const mod = await import("@/lib/storage/drive-provider");
    return mod.getDriveStorageProvider();
  }

  it("accesses shared folder with supportsAllDrives on files.get", async () => {
    const provider = await loadProvider();
    await provider.ensureFolderPath([]);

    expect(mockFilesGet).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: "shared-root-folder-id",
        supportsAllDrives: true,
      }),
    );
  });

  it("lists children with supportsAllDrives and includeItemsFromAllDrives", async () => {
    mockFilesList
      .mockResolvedValueOnce({ data: { files: [] } })
      .mockResolvedValueOnce({ data: { files: [{ id: "child-folder-id", name: "Knowledge" }] } });

    const provider = await loadProvider();
    await provider.ensureFolderPath(["Knowledge"]);

    expect(mockFilesList).toHaveBeenCalledWith(
      expect.objectContaining({
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        q: expect.stringContaining("'shared-root-folder-id' in parents"),
      }),
    );
    expect(mockFilesList).toHaveBeenCalledWith(
      expect.objectContaining({
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        q: expect.stringContaining("name='Knowledge'"),
      }),
    );
  });

  it("creates folders with supportsAllDrives on files.create", async () => {
    const provider = await loadProvider();
    await provider.ensureFolderPath(["Knowledge"]);

    expect(mockFilesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        supportsAllDrives: true,
        requestBody: expect.objectContaining({
          name: "Knowledge",
          mimeType: "application/vnd.google-apps.folder",
          parents: ["shared-root-folder-id"],
        }),
      }),
    );
  });

  it("creates resumable upload session with supportsAllDrives", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ Location: "https://upload.example/resumable" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = await loadProvider();
    const session = await provider.createResumableUpload({
      filename: "test.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      folderId: "folder-id",
    });

    expect(session.uploadUrl).toBe("https://upload.example/resumable");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/uploadType=resumable/),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/supportsAllDrives=true/),
      expect.any(Object),
    );
  });

  it("maps 403 folder access errors to permission denied", async () => {
    mockFilesGet.mockRejectedValue({
      code: 403,
      response: {
        status: 403,
        data: { error: { errors: [{ reason: "insufficientPermissions" }] } },
      },
    });

    const provider = await loadProvider();

    await expect(provider.ensureFolderPath(["Knowledge"])).rejects.toMatchObject({
      code: "DRIVE_FOLDER_ACCESS_DENIED",
      googleHttpStatus: 403,
      googleErrorReason: "insufficientPermissions",
    });
  });

  it("maps 404 folder access errors to folder not found", async () => {
    mockFilesGet.mockRejectedValue({
      code: 404,
      response: {
        status: 404,
        data: { error: { errors: [{ reason: "notFound" }] } },
      },
    });

    const provider = await loadProvider();

    await expect(provider.ensureFolderPath(["Knowledge"])).rejects.toMatchObject({
      code: "DRIVE_FOLDER_NOT_FOUND",
      googleHttpStatus: 404,
      googleErrorReason: "notFound",
    });
  });

  it("maps upload session 403 to permission denied", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { errors: [{ reason: "insufficientPermissions" }] } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = await loadProvider();

    await expect(
      provider.createResumableUpload({
        filename: "test.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        folderId: "folder-id",
      }),
    ).rejects.toMatchObject({
      code: "DRIVE_FOLDER_ACCESS_DENIED",
      googleHttpStatus: 403,
      googleErrorReason: "insufficientPermissions",
    });
  });

  it("maps upload session 404 to folder not found", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { errors: [{ reason: "notFound" }] } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = await loadProvider();

    await expect(
      provider.createResumableUpload({
        filename: "test.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        folderId: "missing-folder-id",
      }),
    ).rejects.toMatchObject({
      code: "DRIVE_FOLDER_NOT_FOUND",
      googleHttpStatus: 404,
      googleErrorReason: "notFound",
    });
  });
});
