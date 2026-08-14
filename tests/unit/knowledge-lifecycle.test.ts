import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFrom = vi.fn();
const mockServiceClient = { from: mockFrom };

const mockCompleteResumableUpload = vi.fn();
const mockFinalizeUpload = vi.fn();
const mockDownloadFile = vi.fn();

const mockDriveProvider = {
  completeResumableUpload: (...args: unknown[]) => mockCompleteResumableUpload(...args),
  finalizeUpload: (...args: unknown[]) => mockFinalizeUpload(...args),
  createResumableUpload: vi.fn(),
  downloadFile: (...args: unknown[]) => mockDownloadFile(...args),
};

function chainable(result: { data?: unknown; error?: unknown } = {}) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(result),
    maybeSingle: vi.fn().mockResolvedValue(result),
  };
  return chain;
}

describe("knowledge upload lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    mockFrom.mockReset();
    mockCompleteResumableUpload.mockReset();
    mockFinalizeUpload.mockReset();
    mockDownloadFile.mockReset();

    vi.doMock("@/lib/supabase/server", () => ({
      createSupabaseServiceClient: () => mockServiceClient,
    }));

    vi.doMock("@/lib/storage/drive-provider", () => ({
      getDriveStorageProvider: () => mockDriveProvider,
      isDriveStorageConfigured: () => true,
      resolveKnowledgeFolderSegments: () => ["Knowledge", "Global"],
    }));

    mockFinalizeUpload.mockResolvedValue({
      driveFileId: "drive-123",
      webViewUrl: "https://drive.example/file",
      checksumSha256: "abc",
      sizeBytes: 100,
    });
    mockCompleteResumableUpload.mockResolvedValue("drive-123");
    mockDownloadFile.mockResolvedValue(Buffer.from("pdf-bytes"));
  });

  afterEach(() => {
    vi.doUnmock("@/lib/supabase/server");
    vi.doUnmock("@/lib/storage/drive-provider");
    vi.doUnmock("@/lib/knowledge/document-processor");
    vi.doUnmock("@/lib/knowledge/file-extractors");
  });

  it("finalizeKnowledgeUpload sets uploaded then runs extraction", async () => {
    const processMock = vi.fn().mockResolvedValue({ id: "doc-1", status: "ready" });
    vi.doMock("@/lib/knowledge/document-processor", () => ({
      processKnowledgeDocument: processMock,
    }));

    const doc = {
      id: "doc-1",
      user_id: "user-1",
      filename: "test.pdf",
      mime_type: "application/pdf",
      size_bytes: 100,
      status: "uploading",
    };

    const updates: Array<Record<string, unknown>> = [];
    mockFrom.mockImplementation((table: string) => {
      if (table === "knowledge_documents") {
        const chain = chainable({ data: doc, error: null });
        chain.update.mockImplementation((payload: Record<string, unknown>) => {
          updates.push(payload);
          return chain;
        });
        return chain;
      }
      return chainable();
    });

    const { finalizeKnowledgeUpload } = await import("@/lib/knowledge/knowledge-service");

    await finalizeKnowledgeUpload({
      userId: "user-1",
      documentId: "doc-1",
      driveFileId: "drive-123",
    });

    expect(updates.some((u) => u.status === "uploaded")).toBe(true);
    expect(processMock).toHaveBeenCalledWith("doc-1");
  });

  it("uploadKnowledgeFileViaServer uses stored upload_url and finalizes", async () => {
    const processMock = vi.fn().mockResolvedValue({ id: "doc-3", status: "ready" });
    vi.doMock("@/lib/knowledge/document-processor", () => ({
      processKnowledgeDocument: processMock,
    }));

    const doc = {
      id: "doc-3",
      user_id: "user-1",
      filename: "server.pdf",
      mime_type: "application/pdf",
      size_bytes: 50,
      status: "uploading",
      metadata: { upload_url: "https://upload.example/resumable", upload_folder_id: "folder-1" },
    };

    mockFrom.mockImplementation((table: string) => {
      if (table === "knowledge_documents") {
        return chainable({ data: doc, error: null });
      }
      return chainable();
    });

    const { uploadKnowledgeFileViaServer } = await import("@/lib/knowledge/knowledge-service");

    await uploadKnowledgeFileViaServer({
      userId: "user-1",
      documentId: "doc-3",
      buffer: Buffer.from("pdf"),
    });

    expect(mockCompleteResumableUpload).toHaveBeenCalledWith({
      uploadUrl: "https://upload.example/resumable",
      mimeType: "application/pdf",
      buffer: expect.any(Buffer),
    });
    expect(processMock).toHaveBeenCalledWith("doc-3");
  });
});

describe("processKnowledgeDocument lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    mockFrom.mockReset();
    mockDownloadFile.mockReset();
    mockDownloadFile.mockResolvedValue(Buffer.from("pdf-bytes"));

    vi.doMock("@/lib/supabase/server", () => ({
      createSupabaseServiceClient: () => mockServiceClient,
    }));

    vi.doMock("@/lib/storage/drive-provider", () => ({
      getDriveStorageProvider: () => mockDriveProvider,
      isDriveStorageConfigured: () => true,
    }));

    vi.doMock("@/lib/knowledge/file-extractors", () => ({
      extractTextFromBuffer: vi.fn(async () => ({
        text: "Sample extracted knowledge text for lifecycle test.",
        needsOcr: false,
      })),
      isSyncExtractionSafe: () => true,
      buildChunks: (text: string) => [text],
    }));
  });

  afterEach(() => {
    vi.doUnmock("@/lib/supabase/server");
    vi.doUnmock("@/lib/storage/drive-provider");
    vi.doUnmock("@/lib/knowledge/file-extractors");
  });

  it("transitions through extracting to ready", async () => {
    const doc = {
      id: "doc-1",
      user_id: "user-1",
      filename: "test.pdf",
      mime_type: "application/pdf",
      size_bytes: 100,
      status: "uploaded",
      drive_file_id: "drive-123",
    };

    const readyDoc = {
      ...doc,
      status: "ready",
      extracted_text: "Sample extracted knowledge text for lifecycle test.",
    };

    const updates: Array<Record<string, unknown>> = [];
    mockFrom.mockImplementation((table: string) => {
      if (table === "knowledge_documents") {
        const chain = chainable({ data: doc, error: null });
        chain.update.mockImplementation((payload: Record<string, unknown>) => {
          updates.push(payload);
          return chain;
        });
        chain.single.mockResolvedValue({ data: readyDoc, error: null });
        return chain;
      }
      if (table === "knowledge_chunks") {
        return chainable({ data: null, error: null });
      }
      return chainable();
    });

    const { processKnowledgeDocument } = await import("@/lib/knowledge/document-processor");
    const result = await processKnowledgeDocument("doc-1");

    expect(updates.some((u) => u.status === "extracting")).toBe(true);
    expect(updates.some((u) => u.status === "ready")).toBe(true);
    expect(result.status).toBe("ready");
  });

  it("sets failed and extraction_error on error", async () => {
    mockDownloadFile.mockRejectedValue(new Error("DRIVE_DOWNLOAD_FAILED"));

    const doc = {
      id: "doc-2",
      user_id: "user-1",
      filename: "broken.pdf",
      mime_type: "application/pdf",
      size_bytes: 100,
      status: "uploaded",
      drive_file_id: "drive-456",
    };

    const updates: Array<Record<string, unknown>> = [];
    mockFrom.mockImplementation((table: string) => {
      if (table === "knowledge_documents") {
        const chain = chainable({ data: doc, error: null });
        chain.update.mockImplementation((payload: Record<string, unknown>) => {
          updates.push(payload);
          return chain;
        });
        return chain;
      }
      return chainable();
    });

    const { processKnowledgeDocument } = await import("@/lib/knowledge/document-processor");

    await expect(processKnowledgeDocument("doc-2")).rejects.toThrow("DRIVE_DOWNLOAD_FAILED");

    const failedUpdate = updates.find((u) => u.status === "failed");
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate?.extraction_error).toBe("DRIVE_DOWNLOAD_FAILED");
  });
});

describe("deleteKnowledgeDocument", () => {
  const mockDeleteFile = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    mockFrom.mockReset();
    mockDeleteFile.mockReset();

    vi.doMock("@/lib/supabase/server", () => ({
      createSupabaseServiceClient: () => mockServiceClient,
    }));

    vi.doMock("@/lib/storage/drive-provider", () => ({
      getDriveStorageProvider: () => ({
        ...mockDriveProvider,
        deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
      }),
      isDriveStorageConfigured: () => true,
    }));
  });

  afterEach(() => {
    vi.doUnmock("@/lib/supabase/server");
    vi.doUnmock("@/lib/storage/drive-provider");
  });

  it("deletes Drive file then removes document from database", async () => {
    const doc = {
      id: "doc-del-1",
      user_id: "user-1",
      filename: "report.pdf",
      drive_file_id: "drive-abc",
      status: "ready",
    };

    mockDeleteFile.mockResolvedValue({ httpStatus: 204 });

    mockFrom.mockImplementation((table: string) => {
      if (table === "knowledge_documents") {
        const chain = chainable({ data: doc, error: null });
        chain.delete.mockReturnValue(chain);
        chain.eq.mockReturnValue(chain);
        return chain;
      }
      return chainable();
    });

    const { deleteKnowledgeDocument } = await import("@/lib/knowledge/knowledge-service");
    await deleteKnowledgeDocument("user-1", "doc-del-1");

    expect(mockDeleteFile).toHaveBeenCalledWith("drive-abc");
  });

  it("continues when Drive file is already deleted (404)", async () => {
    const doc = {
      id: "doc-del-2",
      user_id: "user-1",
      filename: "gone.pdf",
      drive_file_id: "drive-gone",
      status: "ready",
    };

    mockDeleteFile.mockResolvedValue({ httpStatus: 404 });

    mockFrom.mockImplementation((table: string) => {
      if (table === "knowledge_documents") {
        const chain = chainable({ data: doc, error: null });
        chain.delete.mockReturnValue(chain);
        chain.eq.mockReturnValue(chain);
        return chain;
      }
      return chainable();
    });

    const { deleteKnowledgeDocument } = await import("@/lib/knowledge/knowledge-service");
    await expect(deleteKnowledgeDocument("user-1", "doc-del-2")).resolves.toBeUndefined();
  });

  it("throws DRIVE_DELETE_PERMISSION_DENIED for 403 Drive errors", async () => {
    const { DriveStorageError } = await import("@/lib/storage/drive-errors");
    const doc = {
      id: "doc-del-4",
      user_id: "user-1",
      filename: "forbidden.pdf",
      drive_file_id: "drive-forbidden",
      status: "ready",
      metadata: {},
    };

    mockDeleteFile.mockRejectedValue(
      new DriveStorageError(
        "DRIVE_DELETE_PERMISSION_DENIED",
        "Permission denied",
        { stage: "file_delete", googleHttpStatus: 403 },
      ),
    );

    mockFrom.mockImplementation((table: string) => {
      if (table === "knowledge_documents") {
        const chain = chainable({ data: doc, error: null });
        chain.update.mockReturnValue(chain);
        chain.delete.mockReturnValue(chain);
        chain.eq.mockReturnValue(chain);
        return chain;
      }
      return chainable();
    });

    const { deleteKnowledgeDocument } = await import("@/lib/knowledge/knowledge-service");
    await expect(deleteKnowledgeDocument("user-1", "doc-del-4")).rejects.toThrow(
      "DRIVE_DELETE_PERMISSION_DENIED",
    );
  });

  it("throws DRIVE_DELETE_FAILED for other Drive errors", async () => {
    const doc = {
      id: "doc-del-3",
      user_id: "user-1",
      filename: "locked.pdf",
      drive_file_id: "drive-locked",
      status: "ready",
      metadata: {},
    };

    mockDeleteFile.mockRejectedValue(new Error("Permission denied"));

    mockFrom.mockImplementation((table: string) => {
      if (table === "knowledge_documents") {
        const chain = chainable({ data: doc, error: null });
        chain.update.mockReturnValue(chain);
        chain.delete.mockReturnValue(chain);
        chain.eq.mockReturnValue(chain);
        return chain;
      }
      return chainable();
    });

    const { deleteKnowledgeDocument } = await import("@/lib/knowledge/knowledge-service");
    await expect(deleteKnowledgeDocument("user-1", "doc-del-3")).rejects.toThrow(
      "DRIVE_DELETE_FAILED",
    );
  });
});

describe("knowledge retrieval status filter", () => {
  it("searchKnowledge fallback query filters only ready documents", async () => {
    const source = await import("fs/promises").then((fs) =>
      fs.readFile(new URL("../../lib/knowledge/knowledge-service.ts", import.meta.url), "utf8"),
    );
    expect(source).toContain('.eq("knowledge_documents.status", "ready")');
  });

  it("search_knowledge_chunks SQL migration filters only ready documents", async () => {
    const source = await import("fs/promises").then((fs) =>
      fs.readFile(
        new URL("../../supabase/migrations/20260814140000_knowledge_drive_fts.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(source).toContain("AND kd.status = 'ready'");
  });
});
