import type { ExternalVisualArchive } from "./visual-references";
import type { CompiledImageReferenceAsset } from "./visual-references";

export interface ExternalVisualMaterializer {
  materialize(input: {
    researchRunId: string;
    referenceIds: string[];
    signal?: AbortSignal;
  }): Promise<CompiledImageReferenceAsset[]>;
}

type ArchiveResponse = {
  ok?: boolean;
  data?: {
    driveFileId?: string;
    driveWebUrl?: string | null;
    filename?: string;
    mimeType?: string;
    sizeBytes?: number | null;
    archivedAt?: string;
  };
  message?: string;
};

type MaterializeResponse = {
  ok?: boolean;
  data?: { assets?: CompiledImageReferenceAsset[] };
  message?: string;
};

export class ExternalVisualArchiveClient implements ExternalVisualArchive {
  constructor(
    private readonly baseUrl: string,
    private readonly bearerToken: string,
  ) {}

  async archive(input: Parameters<ExternalVisualArchive["archive"]>[0]) {
    const response = await fetch(
      `${this.baseUrl.replace(/\/+$/, "")}/api/internal/research-visual-archive`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.bearerToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          researchRunId: input.researchRunId,
          referenceId: input.referenceId,
          sourceUrl: input.sourceUrl,
          imageUrl: input.imageUrl,
          expectedSha256: input.image.contentSha256,
          expectedMimeType: input.image.mimeType,
          expectedWidth: input.image.width,
          expectedHeight: input.image.height,
        }),
        signal: input.signal,
      },
    );
    let payload: ArchiveResponse = {};
    try {
      payload = (await response.json()) as ArchiveResponse;
    } catch {
      // HTTP status below remains authoritative.
    }
    const data = payload.data;
    if (
      !response.ok ||
      payload.ok !== true ||
      !data?.driveFileId ||
      !data.filename ||
      !data.mimeType ||
      !data.archivedAt
    ) {
      throw new Error(payload.message || `RESEARCH_VISUAL_ARCHIVE_FAILED:${response.status}`);
    }
    return {
      driveFileId: data.driveFileId,
      driveWebUrl: data.driveWebUrl ?? null,
      filename: data.filename,
      mimeType: data.mimeType,
      sizeBytes: data.sizeBytes ?? null,
      archivedAt: data.archivedAt,
    };
  }
}

export class ExternalVisualMaterializerClient implements ExternalVisualMaterializer {
  constructor(
    private readonly baseUrl: string,
    private readonly bearerToken: string,
  ) {}

  async materialize(input: {
    researchRunId: string;
    referenceIds: string[];
    signal?: AbortSignal;
  }): Promise<CompiledImageReferenceAsset[]> {
    const response = await fetch(
      `${this.baseUrl.replace(/\/+$/, "")}/api/internal/research-visual-materialize`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.bearerToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          researchRunId: input.researchRunId,
          referenceIds: input.referenceIds,
        }),
        signal: input.signal,
      },
    );
    let payload: MaterializeResponse = {};
    try {
      payload = (await response.json()) as MaterializeResponse;
    } catch {
      // HTTP status below remains authoritative.
    }
    if (!response.ok || payload.ok !== true || !Array.isArray(payload.data?.assets)) {
      throw new Error(payload.message || `RESEARCH_VISUAL_MATERIALIZE_FAILED:${response.status}`);
    }
    return payload.data.assets;
  }
}
