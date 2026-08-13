export type AssetKind = "image" | "video";

export type IngestErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_REQUEST"
  | "ASSET_TOO_LARGE"
  | "UNSAFE_URL"
  | "HOST_NOT_ALLOWED"
  | "INVALID_MIME"
  | "DOWNLOAD_TIMEOUT"
  | "UPSTREAM_ERROR"
  | "B2_UPLOAD_FAILED"
  | "NOT_CONFIGURED";

export class IngestError extends Error {
  readonly code: IngestErrorCode;
  readonly status: number;

  constructor(code: IngestErrorCode, status: number, message?: string) {
    super(message ?? code);
    this.name = "IngestError";
    this.code = code;
    this.status = status;
  }
}

export interface AssetIngestRequest {
  source_url: string;
  allowed_hosts: string[];
  kind: AssetKind;
  project_id: string;
  job_id: string;
  stage: string;
  provider_task_id: string;
  variant_index: number;
}

export interface AssetIngestSuccess {
  ok: true;
  bucket: string;
  object_key: string;
  kind: AssetKind;
  mime_type: string;
  size_bytes: number;
  checksum_sha256: string;
}

export interface AssetIngestFailure {
  ok: false;
  code: IngestErrorCode;
}

export type AssetIngestResponse = AssetIngestSuccess | AssetIngestFailure;
