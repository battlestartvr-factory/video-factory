export interface ArchivedMediaOutput {
  url: string;
  providerUrl: string;
  kind: "image" | "video";
  mimeType: string;
  storageProvider: "google_drive";
  driveFileId: string;
  driveWebUrl: string | null;
  filename: string;
  sizeBytes: number | null;
  archivedAt: string;
}

export interface MediaArchiveService {
  archive(input: {
    generationId: string;
    outputIndex: number;
    sourceUrl: string;
    kind: "image" | "video";
    signal?: AbortSignal;
  }): Promise<ArchivedMediaOutput>;
}

export class GenerationArchiveClient implements MediaArchiveService {
  constructor(
    private readonly baseUrl: string,
    private readonly bearerToken: string,
  ) {}

  async archive(input: {
    generationId: string;
    outputIndex: number;
    sourceUrl: string;
    kind: "image" | "video";
    signal?: AbortSignal;
  }): Promise<ArchivedMediaOutput> {
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/api/internal/generation-archive`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        generationId: input.generationId,
        outputIndex: input.outputIndex,
        sourceUrl: input.sourceUrl,
        kind: input.kind,
      }),
      signal: input.signal,
    });

    let payload: { ok?: boolean; data?: ArchivedMediaOutput; message?: string } = {};
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      // Preserve the HTTP status below.
    }

    if (!response.ok || payload.ok !== true || !payload.data?.driveFileId) {
      throw new Error(payload.message || `GENERATION_ARCHIVE_FAILED:${response.status}`);
    }
    return payload.data;
  }
}
